import { Prisma } from '@prisma/client';

const mockPrisma = {
  $queryRaw: jest.fn(),
  settings: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  user: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  list: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  movie: { findMany: jest.fn(), findUnique: jest.fn() },
  listMovie: { findMany: jest.fn() },
  movieEvent: { findMany: jest.fn() },
  deletionRequest: { findMany: jest.fn(), findUnique: jest.fn() },
  syncRun: { findMany: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../scheduler', () => ({
  __esModule: true,
  syncListById: jest.fn(),
  syncAll: jest.fn(),
  syncDue: jest.fn(),
  forceReconcileWatched: jest.fn(),
}));
jest.mock('../reconcile', () => ({
  __esModule: true,
  approveDeletion: jest.fn(),
  keepDeletion: jest.fn(),
  deleteList: jest.fn(),
  handleListDisabled: jest.fn(),
  dropKeepStatus: jest.fn(),
  convertToManaged: jest.fn(),
  getSoleOwnerUserId: jest.fn(),
}));
jest.mock('../auth', () => ({
  __esModule: true,
  validateSession: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  SESSION_TTL_MS: 1000,
}));
jest.mock('../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

import request from 'supertest';
import { createApp, createHeadlessApp } from './app';
import { syncListById, syncAll, syncDue, forceReconcileWatched } from '../scheduler';
import {
  approveDeletion,
  keepDeletion,
  deleteList,
  handleListDisabled,
  dropKeepStatus,
  convertToManaged,
  getSoleOwnerUserId,
} from '../reconcile';
import { validateSession, login, logout } from '../auth';
import { JellyfinAuthError } from '../api/jellyfin.errors';

const app = createApp();

// Session cookies the mocked validateSession understands (see beforeEach).
const ADMIN = 'filmstrip_session=admin';
const USER = 'filmstrip_session=user';

const adminUser = { id: 1, name: 'Admin', tag: 'admin', jellyfinUserId: 'jf-admin' };
const regularUser = { id: 2, name: 'Sam', tag: 'sam', jellyfinUserId: 'jf-sam' };

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('mock', { code, clientVersion: 'test' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$queryRaw.mockResolvedValue([{ '1': 1 }]);
  (validateSession as jest.Mock).mockImplementation(async (token: string) => {
    if (token === 'admin') return { id: 1, token, userId: 1, isAdmin: true, user: adminUser };
    if (token === 'user') return { id: 2, token, userId: 2, isAdmin: false, user: regularUser };
    return null;
  });
});

describe('GET /api/health (public)', () => {
  it('returns ok + version/mode without a session when the DB is reachable', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', mode: 'gui' });
    expect(res.body.version).toEqual(expect.any(String));
    expect(res.body.uptime).toEqual(expect.any(Number));
  });

  it('returns 503 degraded when the DB probe fails', async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', mode: 'gui' });
  });
});

describe('headless app', () => {
  const headless = createHeadlessApp();

  it('serves /api/health with mode headless', async () => {
    const res = await request(headless).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', mode: 'headless' });
  });

  it('404s auth-gated routes (they are not mounted — no SPA, no auth)', async () => {
    const res = await request(headless).get('/api/lists');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });

  it('404s non-api paths (no SPA)', async () => {
    const res = await request(headless).get('/');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });
});

describe('unknown /api route', () => {
  it('returns a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });
});

describe('auth', () => {
  it('POST /api/auth/login sets a cookie and returns the user', async () => {
    (login as jest.Mock).mockResolvedValue({ token: 'tok', user: adminUser, isAdmin: true });
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: adminUser, isAdmin: true });
    expect(res.headers['set-cookie'][0]).toMatch(/filmstrip_session=tok/);
  });

  it('POST /api/auth/login maps bad credentials to 401', async () => {
    (login as jest.Mock).mockRejectedValue(
      new JellyfinAuthError('bad-credentials', 'Invalid Jellyfin credentials.')
    );
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid Jellyfin credentials.');
  });

  it('POST /api/auth/login maps an unreachable server to 502 (not a fake 401)', async () => {
    (login as jest.Mock).mockRejectedValue(
      new JellyfinAuthError('unreachable', 'Could not reach the Jellyfin server — check the Jellyfin URL in Settings.')
    );
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'pw' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/could not reach/i);
  });

  it('POST /api/auth/login maps an invalid URL to 400', async () => {
    (login as jest.Mock).mockRejectedValue(
      new JellyfinAuthError('invalid-url', 'The configured Jellyfin URL is invalid — it must include http:// or https://.')
    );
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'pw' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http:\/\//);
  });

  it('POST /api/auth/login maps "not configured" to 400', async () => {
    (login as jest.Mock).mockRejectedValue(new Error('Jellyfin is not configured. Set jellyfinUrl in Settings.'));
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'pw' });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/login maps an unexpected error to a logged 500', async () => {
    (login as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'pw' });
    expect(res.status).toBe(500);
  });

  it('GET /api/auth/me returns the session user', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: adminUser, isAdmin: true });
  });

  it('GET /api/auth/me without a session is 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout clears the cookie', async () => {
    (logout as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/auth/logout').set('Cookie', ADMIN);
    expect(res.status).toBe(204);
    expect(logout).toHaveBeenCalledWith('admin');
  });
});

describe('auth gating', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await request(app).get('/api/lists');
    expect(res.status).toBe(401);
  });

  it('lets any authenticated user read lists', async () => {
    mockPrisma.list.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/lists').set('Cookie', USER);
    expect(res.status).toBe(200);
  });

  it('forbids a non-admin from an admin-only route', async () => {
    const res = await request(app).get('/api/users').set('Cookie', USER);
    expect(res.status).toBe(403);
  });
});

describe('settings (admin)', () => {
  it('GET creates a blank singleton when none exists', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    mockPrisma.settings.create.mockResolvedValue({ id: 1, dryRun: false });
    const res = await request(app).get('/api/settings').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(mockPrisma.settings.create).toHaveBeenCalledWith({ data: { id: 1 } });
  });

  it('PATCH updates and echoes the row', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1 });
    mockPrisma.settings.update.mockResolvedValue({ id: 1, dryRun: true });
    const res = await request(app).patch('/api/settings').set('Cookie', ADMIN).send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(mockPrisma.settings.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { dryRun: true } });
  });

  it('PATCH rejects an unknown field', async () => {
    const res = await request(app).patch('/api/settings').set('Cookie', ADMIN).send({ bogus: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Validation failed/);
  });

  it('PATCH rejects a schemeless Radarr URL', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', ADMIN)
      .send({ radarrUrl: 'radarr.magi-home.xyz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http:\/\//);
    expect(mockPrisma.settings.update).not.toHaveBeenCalled();
  });

  it('PATCH accepts a valid http connection URL', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1 });
    mockPrisma.settings.update.mockResolvedValue({ id: 1, radarrUrl: 'http://radarr:7878' });
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', ADMIN)
      .send({ radarrUrl: 'http://radarr:7878' });
    expect(res.status).toBe(200);
    expect(mockPrisma.settings.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { radarrUrl: 'http://radarr:7878' },
    });
  });

  it('PATCH allows clearing a URL with null', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1 });
    mockPrisma.settings.update.mockResolvedValue({ id: 1, jellyfinUrl: null });
    const res = await request(app).patch('/api/settings').set('Cookie', ADMIN).send({ jellyfinUrl: null });
    expect(res.status).toBe(200);
  });
});

describe('users (admin)', () => {
  it('GET / lists users', async () => {
    mockPrisma.user.findMany.mockResolvedValue([adminUser]);
    const res = await request(app).get('/api/users').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /:id returns 404 when missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/users/5').set('Cookie', ADMIN);
    expect(res.status).toBe(404);
  });

  it('POST creates a user', async () => {
    mockPrisma.user.create.mockResolvedValue({ id: 3, name: 'Sam', tag: 'sam' });
    const res = await request(app).post('/api/users').set('Cookie', ADMIN).send({ name: 'Sam', tag: 'sam' });
    expect(res.status).toBe(201);
  });

  it('POST maps a duplicate tag to 409', async () => {
    mockPrisma.user.create.mockRejectedValue(knownError('P2002'));
    const res = await request(app).post('/api/users').set('Cookie', ADMIN).send({ name: 'Sam', tag: 'admin' });
    expect(res.status).toBe(409);
  });

  it('PATCH maps a missing row to 404', async () => {
    mockPrisma.user.update.mockRejectedValue(knownError('P2025'));
    const res = await request(app).patch('/api/users/9').set('Cookie', ADMIN).send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE returns 204', async () => {
    mockPrisma.user.delete.mockResolvedValue({});
    const res = await request(app).delete('/api/users/2').set('Cookie', ADMIN);
    expect(res.status).toBe(204);
  });

  it('POST /:id/refresh-watched accepts and runs the refresh detached', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(regularUser);
    (forceReconcileWatched as jest.Mock).mockResolvedValue({
      userId: 2,
      filmsKnownWatched: 12,
      listsReconciled: [10],
    });
    const res = await request(app).post('/api/users/2/refresh-watched').set('Cookie', ADMIN);
    // 202, not 200: a full refresh takes minutes, so the response can't wait on the result.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'started', userId: 2, startedAt: expect.any(String) });
    expect(forceReconcileWatched).toHaveBeenCalledWith(2);
  });

  it('POST /:id/refresh-watched still responds when the detached refresh throws', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(regularUser);
    (forceReconcileWatched as jest.Mock).mockRejectedValue(new Error('letterboxd down'));

    const res = await request(app).post('/api/users/2/refresh-watched').set('Cookie', ADMIN);

    // The failure is logged, never surfaced as an unhandled rejection after the response went out.
    expect(res.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve)); // let the detached rejection settle
  });

  it('POST /:id/refresh-watched returns 404 when the user is missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/users/999/refresh-watched').set('Cookie', ADMIN);
    expect(res.status).toBe(404);
    expect(forceReconcileWatched).not.toHaveBeenCalled();
  });

  it('POST /:id/refresh-watched is forbidden for a non-admin', async () => {
    const res = await request(app).post('/api/users/2/refresh-watched').set('Cookie', USER);
    expect(res.status).toBe(403);
  });
});

describe('lists', () => {
  it('POST detects the list type from the URL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1, name: 'Chris' });
    mockPrisma.list.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 3, ...data }));
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', ADMIN)
      .send({ userId: 1, url: 'https://letterboxd.com/chris/watchlist/' });
    expect(res.status).toBe(201);
    expect(res.body.listType).toBe('watchlist');
    expect(res.body.label).toBe("Chris's watchlist");
  });

  it('POST rejects an unsupported URL', async () => {
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', ADMIN)
      .send({ userId: 1, url: 'https://example.com/foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supported Letterboxd/);
  });

  it('POST rejects a non-existent user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', ADMIN)
      .send({ userId: 99, url: 'https://letterboxd.com/chris/watchlist/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
  });

  it('POST maps a duplicate (user,url) to 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1, name: 'Chris' });
    mockPrisma.list.create.mockRejectedValue(knownError('P2002'));
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', ADMIN)
      .send({ userId: 1, url: 'https://letterboxd.com/chris/watchlist/' });
    expect(res.status).toBe(409);
  });

  it('PATCH re-detects listType when the URL changes', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 3, userId: 1 });
    mockPrisma.list.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 3, ...data }));
    const res = await request(app)
      .patch('/api/lists/3')
      .set('Cookie', ADMIN)
      .send({ url: 'https://letterboxd.com/films/popular/' });
    expect(res.status).toBe(200);
    expect(mockPrisma.list.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ listType: 'popular_movies' }) })
    );
  });

  it('POST rejects permanence combined with unwatchedOnly', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1, name: 'Chris' });
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', ADMIN)
      .send({
        userId: 1,
        url: 'https://letterboxd.com/chris/watchlist/',
        permanence: true,
        unwatchedOnly: true,
      });
    expect(res.status).toBe(400);
    expect(mockPrisma.list.create).not.toHaveBeenCalled();
  });

  it('PATCH rejects turning on removeOnWatch when permanence is already on', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({
      id: 3,
      userId: 1,
      permanence: true,
      unwatchedOnly: false,
      removeOnWatch: false,
      enabled: true,
      user: { id: 1 },
    });
    const res = await request(app)
      .patch('/api/lists/3')
      .set('Cookie', ADMIN)
      .send({ removeOnWatch: true });
    expect(res.status).toBe(400);
    expect(mockPrisma.list.update).not.toHaveBeenCalled();
  });

  it('PATCH disabling a list calls handleListDisabled', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({
      id: 3,
      userId: 1,
      permanence: false,
      unwatchedOnly: false,
      removeOnWatch: false,
      enabled: true,
      user: { id: 1, name: 'Chris' },
    });
    mockPrisma.list.update.mockResolvedValue({ id: 3, enabled: false });
    (handleListDisabled as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).patch('/api/lists/3').set('Cookie', ADMIN).send({ enabled: false });

    expect(res.status).toBe(200);
    expect(handleListDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, enabled: false, user: expect.objectContaining({ id: 1 }) })
    );
  });

  it('PATCH re-enabling a list does not call handleListDisabled', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({
      id: 3,
      userId: 1,
      permanence: false,
      unwatchedOnly: false,
      removeOnWatch: false,
      enabled: false,
      user: { id: 1, name: 'Chris' },
    });
    mockPrisma.list.update.mockResolvedValue({ id: 3, enabled: true });

    const res = await request(app).patch('/api/lists/3').set('Cookie', ADMIN).send({ enabled: true });

    expect(res.status).toBe(200);
    expect(handleListDisabled).not.toHaveBeenCalled();
  });

  it('POST /:id/sync returns the SyncResult', async () => {
    // USER (id=2) owns this list, so a non-admin may sync it.
    mockPrisma.list.findUnique.mockResolvedValue({ id: 3, userId: 2 });
    (syncListById as jest.Mock).mockResolvedValue({ listId: 3, status: 'success', added: 2 });
    const res = await request(app).post('/api/lists/3/sync').set('Cookie', USER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ listId: 3, status: 'success' });
    expect(syncListById).toHaveBeenCalledWith(3);
  });

  it('POST /:id/sync maps a disabled/missing list to 400', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 3, userId: 1 });
    (syncListById as jest.Mock).mockRejectedValue(new Error('List id=3 not found, disabled, or owner disabled.'));
    const res = await request(app).post('/api/lists/3/sync').set('Cookie', ADMIN);
    expect(res.status).toBe(400);
  });

  it('DELETE removes the list via reconcile.deleteList', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 3, userId: 1 });
    (deleteList as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).delete('/api/lists/3').set('Cookie', ADMIN);
    expect(res.status).toBe(204);
    expect(deleteList).toHaveBeenCalledWith(3);
  });

  it('DELETE maps a missing list to 404', async () => {
    // No such list -> the ownership pre-check 404s before deleteList runs.
    mockPrisma.list.findUnique.mockResolvedValue(null);
    const res = await request(app).delete('/api/lists/3').set('Cookie', ADMIN);
    expect(res.status).toBe(404);
    expect(deleteList).not.toHaveBeenCalled();
  });

  it('PATCH by a non-owner non-admin is forbidden', async () => {
    // List 3 is owned by user 1; USER is id=2 and not an admin.
    mockPrisma.list.findUnique.mockResolvedValue({ id: 3, userId: 1 });
    const res = await request(app).patch('/api/lists/3').set('Cookie', USER).send({ enabled: false });
    expect(res.status).toBe(403);
    expect(mockPrisma.list.update).not.toHaveBeenCalled();
  });

  it('POST create by a non-admin for another user is forbidden', async () => {
    // USER (id=2) may not create a list owned by user 1.
    const res = await request(app)
      .post('/api/lists')
      .set('Cookie', USER)
      .send({ userId: 1, url: 'https://letterboxd.com/chris/watchlist/' });
    expect(res.status).toBe(403);
    expect(mockPrisma.list.create).not.toHaveBeenCalled();
  });

  it('DELETE by a non-owner non-admin is forbidden', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 3, userId: 1 });
    const res = await request(app).delete('/api/lists/3').set('Cookie', USER);
    expect(res.status).toBe(403);
    expect(deleteList).not.toHaveBeenCalled();
  });

  it('POST /:id/sync by a non-owner non-admin is forbidden', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 3, userId: 1 });
    const res = await request(app).post('/api/lists/3/sync').set('Cookie', USER);
    expect(res.status).toBe(403);
    expect(syncListById).not.toHaveBeenCalled();
  });
});

describe('me (self-service)', () => {
  it('PATCH /api/me sets the caller’s Letterboxd username', async () => {
    mockPrisma.user.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 2, ...data }));
    const res = await request(app).patch('/api/me').set('Cookie', USER).send({ letterboxdUsername: 'sam' });
    expect(res.status).toBe(200);
    // Always targets the session user, never a body-supplied id.
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2 }, data: { letterboxdUsername: 'sam' } })
    );
  });

  it('PATCH /api/me rejects fields other than letterboxdUsername', async () => {
    const res = await request(app).patch('/api/me').set('Cookie', USER).send({ tag: 'hacked' });
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('PATCH /api/me rejects a path-bearing letterboxd username', async () => {
    // Guards the scrape URL (letterboxd.com/<username>/films/) against injection.
    const res = await request(app).patch('/api/me').set('Cookie', USER).send({ letterboxdUsername: 'a/../b' });
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('PATCH /api/me requires a session', async () => {
    const res = await request(app).patch('/api/me').send({ letterboxdUsername: 'sam' });
    expect(res.status).toBe(401);
  });
});

describe('deletions', () => {
  beforeEach(() => {
    // assertCanResolveRequest always loads the request first (to find its movieId), even for an
    // admin who'll short-circuit past the ownership check -- give every test a row to find.
    mockPrisma.deletionRequest.findUnique.mockResolvedValue({ id: 4, movieId: 1 });
  });

  it('GET defaults to pending (admin: unfiltered)', async () => {
    mockPrisma.deletionRequest.findMany.mockResolvedValue([{ id: 1, movieId: 1, status: 'pending' }]);
    const res = await request(app).get('/api/deletions').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(mockPrisma.deletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending' } })
    );
    expect(res.body).toEqual([{ id: 1, movieId: 1, status: 'pending' }]);
  });

  it('GET rejects an invalid status', async () => {
    const res = await request(app).get('/api/deletions?status=bogus').set('Cookie', ADMIN);
    expect(res.status).toBe(400);
  });

  it('GET requires a session', async () => {
    const res = await request(app).get('/api/deletions');
    expect(res.status).toBe(401);
  });

  it('GET for a non-admin returns only requests for films only their own lists ever added', async () => {
    mockPrisma.deletionRequest.findMany.mockResolvedValue([
      { id: 1, movieId: 1, status: 'pending' }, // sole-owned by USER (id=2)
      { id: 2, movieId: 2, status: 'pending' }, // sole-owned by someone else
      { id: 3, movieId: 3, status: 'pending' }, // multiple owners -- ambiguous, admin-only
    ]);
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, list: { userId: 2 } },
      { movieId: 2, list: { userId: 1 } },
      { movieId: 3, list: { userId: 1 } },
      { movieId: 3, list: { userId: 2 } },
    ]);

    const res = await request(app).get('/api/deletions').set('Cookie', USER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, movieId: 1, status: 'pending' }]);
  });

  it('POST /:id/approve resolves the request (admin)', async () => {
    (approveDeletion as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/deletions/4/approve').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 4, status: 'approved' });
  });

  it('POST /:id/approve maps "already" to 409', async () => {
    (approveDeletion as jest.Mock).mockRejectedValue(new Error('DeletionRequest id=4 is already approved.'));
    const res = await request(app).post('/api/deletions/4/approve').set('Cookie', ADMIN);
    expect(res.status).toBe(409);
  });

  it('POST /:id/approve 404s when the request does not exist', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/deletions/999/approve').set('Cookie', ADMIN);
    expect(res.status).toBe(404);
    expect(approveDeletion).not.toHaveBeenCalled();
  });

  it('POST /:id/approve succeeds for a non-admin who is the film\'s sole owner', async () => {
    (getSoleOwnerUserId as jest.Mock).mockResolvedValue(2); // USER is id=2
    (approveDeletion as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/deletions/4/approve').set('Cookie', USER);
    expect(res.status).toBe(200);
    expect(approveDeletion).toHaveBeenCalledWith(4);
  });

  it('POST /:id/approve is forbidden for a non-admin who is not the film\'s sole owner', async () => {
    (getSoleOwnerUserId as jest.Mock).mockResolvedValue(1); // owned by someone else
    const res = await request(app).post('/api/deletions/4/approve').set('Cookie', USER);
    expect(res.status).toBe(403);
    expect(approveDeletion).not.toHaveBeenCalled();
  });

  it('POST /:id/approve is forbidden for a non-admin when ownership is ambiguous', async () => {
    (getSoleOwnerUserId as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post('/api/deletions/4/approve').set('Cookie', USER);
    expect(res.status).toBe(403);
    expect(approveDeletion).not.toHaveBeenCalled();
  });

  it('POST /:id/keep pins and resolves (admin)', async () => {
    (keepDeletion as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/deletions/4/keep').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 4, status: 'kept' });
  });

  it('POST /:id/keep succeeds for a non-admin who is the film\'s sole owner', async () => {
    (getSoleOwnerUserId as jest.Mock).mockResolvedValue(2);
    (keepDeletion as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/deletions/4/keep').set('Cookie', USER);
    expect(res.status).toBe(200);
    expect(keepDeletion).toHaveBeenCalledWith(4);
  });

  it('POST /:id/keep is forbidden for a non-admin who is not the film\'s sole owner', async () => {
    (getSoleOwnerUserId as jest.Mock).mockResolvedValue(1);
    const res = await request(app).post('/api/deletions/4/keep').set('Cookie', USER);
    expect(res.status).toBe(403);
    expect(keepDeletion).not.toHaveBeenCalled();
  });
});

describe('movies', () => {
  it('GET / includes current claiming lists alongside sources', async () => {
    mockPrisma.movie.findMany.mockResolvedValue([
      { id: 1, tmdbId: 100, title: 'A', year: 2020, state: 'added', listMovies: [] },
    ]);
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, list: { id: 10, label: "Chris's watchlist" } },
    ]);

    const res = await request(app).get('/api/movies').set('Cookie', USER);

    expect(res.status).toBe(200);
    expect(res.body[0].claims).toEqual([{ listId: 10, listLabel: "Chris's watchlist" }]);
  });

  it('GET /:id/history includes current claims', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue({ id: 1, tmdbId: 100, title: 'A', year: 2020, state: 'kept' });
    mockPrisma.movieEvent.findMany.mockResolvedValue([]);
    mockPrisma.listMovie.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/movies/1/history').set('Cookie', USER);

    expect(res.status).toBe(200);
    expect(res.body.claims).toEqual([]);
  });

  it('GET /:id/history 404s for a missing movie', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/movies/99/history').set('Cookie', USER);

    expect(res.status).toBe(404);
  });

  it('POST /:id/drop-keep succeeds for an admin', async () => {
    (dropKeepStatus as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/movies/1/drop-keep').set('Cookie', ADMIN);

    expect(res.status).toBe(200);
    expect(dropKeepStatus).toHaveBeenCalledWith(1);
  });

  it('POST /:id/drop-keep is forbidden for a non-admin', async () => {
    const res = await request(app).post('/api/movies/1/drop-keep').set('Cookie', USER);

    expect(res.status).toBe(403);
    expect(dropKeepStatus).not.toHaveBeenCalled();
  });

  it('POST /:id/drop-keep maps "not kept" to 400', async () => {
    (dropKeepStatus as jest.Mock).mockRejectedValue(new Error('Movie id=1 is not kept.'));

    const res = await request(app).post('/api/movies/1/drop-keep').set('Cookie', ADMIN);

    expect(res.status).toBe(400);
  });

  it('POST /:id/drop-keep maps "still claimed" to 409', async () => {
    (dropKeepStatus as jest.Mock).mockRejectedValue(new Error('Movie id=1 is still claimed by an enabled list.'));

    const res = await request(app).post('/api/movies/1/drop-keep').set('Cookie', ADMIN);

    expect(res.status).toBe(409);
  });

  it('POST /:id/convert succeeds for an admin and echoes queued', async () => {
    (convertToManaged as jest.Mock).mockResolvedValue({ queued: true });

    const res = await request(app).post('/api/movies/1/convert').set('Cookie', ADMIN);

    expect(res.status).toBe(200);
    expect(convertToManaged).toHaveBeenCalledWith(1);
    expect(res.body).toEqual({ id: 1, queued: true });
  });

  it('POST /:id/convert is forbidden for a non-admin', async () => {
    const res = await request(app).post('/api/movies/1/convert').set('Cookie', USER);

    expect(res.status).toBe(403);
    expect(convertToManaged).not.toHaveBeenCalled();
  });

  it('POST /:id/convert maps "not found" to 404', async () => {
    (convertToManaged as jest.Mock).mockRejectedValue(new Error('Movie id=1 not found.'));

    const res = await request(app).post('/api/movies/1/convert').set('Cookie', ADMIN);

    expect(res.status).toBe(404);
  });

  it('POST /:id/convert maps "not pre_existing" to 409', async () => {
    (convertToManaged as jest.Mock).mockRejectedValue(new Error('Movie id=1 is not pre_existing (state=added).'));

    const res = await request(app).post('/api/movies/1/convert').set('Cookie', ADMIN);

    expect(res.status).toBe(409);
  });
});

describe('sync-runs', () => {
  it('GET returns recent runs', async () => {
    mockPrisma.syncRun.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = await request(app).get('/api/sync-runs').set('Cookie', USER);
    expect(res.status).toBe(200);
    expect(mockPrisma.syncRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { startedAt: 'desc' }, take: 50 })
    );
  });

  it('GET filters by listId and caps limit', async () => {
    mockPrisma.syncRun.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/sync-runs?listId=7&limit=500').set('Cookie', USER);
    expect(res.status).toBe(200);
    expect(mockPrisma.syncRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { listId: 7 }, take: 200 })
    );
  });
});

describe('sync (admin)', () => {
  it('POST runs syncAll by default', async () => {
    (syncAll as jest.Mock).mockResolvedValue([{ listId: 1, status: 'success' }]);
    const res = await request(app).post('/api/sync').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(syncAll).toHaveBeenCalled();
    expect(syncDue).not.toHaveBeenCalled();
  });

  it('POST ?due=true runs syncDue', async () => {
    (syncDue as jest.Mock).mockResolvedValue([]);
    const res = await request(app).post('/api/sync?due=true').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(syncDue).toHaveBeenCalled();
    expect(syncAll).not.toHaveBeenCalled();
  });
});
