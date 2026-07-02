import { Prisma } from '@prisma/client';

const mockPrisma = {
  $queryRaw: jest.fn(),
  settings: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  user: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  list: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  deletionRequest: { findMany: jest.fn() },
  syncRun: { findMany: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../scheduler', () => ({
  __esModule: true,
  syncListById: jest.fn(),
  syncAll: jest.fn(),
  syncDue: jest.fn(),
}));
jest.mock('../reconcile', () => ({
  __esModule: true,
  approveDeletion: jest.fn(),
  keepDeletion: jest.fn(),
  deleteList: jest.fn(),
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
import { syncListById, syncAll, syncDue } from '../scheduler';
import { approveDeletion, keepDeletion, deleteList } from '../reconcile';
import { validateSession, login, logout } from '../auth';

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
    (login as jest.Mock).mockRejectedValue(new Error('Request failed with status code 401'));
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'bad' });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/login maps "not configured" to 400', async () => {
    (login as jest.Mock).mockRejectedValue(new Error('Jellyfin is not configured. Set jellyfinUrl in Settings.'));
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'pw' });
    expect(res.status).toBe(400);
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

describe('deletions (admin)', () => {
  it('GET defaults to pending', async () => {
    mockPrisma.deletionRequest.findMany.mockResolvedValue([{ id: 1, status: 'pending' }]);
    const res = await request(app).get('/api/deletions').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(mockPrisma.deletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending' } })
    );
  });

  it('GET rejects an invalid status', async () => {
    const res = await request(app).get('/api/deletions?status=bogus').set('Cookie', ADMIN);
    expect(res.status).toBe(400);
  });

  it('POST /:id/approve resolves the request', async () => {
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

  it('POST /:id/keep pins and resolves', async () => {
    (keepDeletion as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/deletions/4/keep').set('Cookie', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 4, status: 'kept' });
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
