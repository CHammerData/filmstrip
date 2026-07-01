import { Prisma } from '@prisma/client';

const mockPrisma = {
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
jest.mock('../reconcile', () => ({ __esModule: true, approveDeletion: jest.fn(), keepDeletion: jest.fn() }));
jest.mock('../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

import request from 'supertest';
import { createApp } from './app';
import { syncListById, syncAll, syncDue } from '../scheduler';
import { approveDeletion, keepDeletion } from '../reconcile';

const app = createApp();

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('mock', { code, clientVersion: 'test' });
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('unknown /api route', () => {
  it('returns a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });
});

describe('settings', () => {
  it('GET creates a blank singleton when none exists', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    mockPrisma.settings.create.mockResolvedValue({ id: 1, dryRun: false });

    const res = await request(app).get('/api/settings');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1, dryRun: false });
    expect(mockPrisma.settings.create).toHaveBeenCalledWith({ data: { id: 1 } });
  });

  it('PATCH updates and echoes the row', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1 });
    mockPrisma.settings.update.mockResolvedValue({ id: 1, dryRun: true, defaultCheckIntervalMin: 30 });

    const res = await request(app).patch('/api/settings').send({ dryRun: true, defaultCheckIntervalMin: 30 });

    expect(res.status).toBe(200);
    expect(mockPrisma.settings.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { dryRun: true, defaultCheckIntervalMin: 30 },
    });
  });

  it('PATCH rejects an unknown field', async () => {
    const res = await request(app).patch('/api/settings').send({ bogus: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Validation failed/);
  });

  it('PATCH rejects an invalid enum value', async () => {
    const res = await request(app).patch('/api/settings').send({ defaultMinimumAvailability: 'someday' });
    expect(res.status).toBe(400);
  });
});

describe('users', () => {
  it('GET / lists users', async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: 1, name: 'Chris', tag: 'chris' }]);
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /:id returns 404 when missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/users/5');
    expect(res.status).toBe(404);
  });

  it('GET /:id rejects a non-numeric id', async () => {
    const res = await request(app).get('/api/users/abc');
    expect(res.status).toBe(400);
  });

  it('POST creates a user', async () => {
    mockPrisma.user.create.mockResolvedValue({ id: 2, name: 'Sam', tag: 'sam' });
    const res = await request(app).post('/api/users').send({ name: 'Sam', tag: 'sam' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 2, tag: 'sam' });
  });

  it('POST maps a duplicate tag to 409', async () => {
    mockPrisma.user.create.mockRejectedValue(knownError('P2002'));
    const res = await request(app).post('/api/users').send({ name: 'Sam', tag: 'chris' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('POST rejects a missing required field', async () => {
    const res = await request(app).post('/api/users').send({ name: 'Sam' });
    expect(res.status).toBe(400);
  });

  it('PATCH maps a missing row to 404', async () => {
    mockPrisma.user.update.mockRejectedValue(knownError('P2025'));
    const res = await request(app).patch('/api/users/9').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE returns 204', async () => {
    mockPrisma.user.delete.mockResolvedValue({});
    const res = await request(app).delete('/api/users/2');
    expect(res.status).toBe(204);
  });
});

describe('lists', () => {
  it('POST detects the list type from the URL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1, name: 'Chris' });
    mockPrisma.list.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 3, ...data }));

    const res = await request(app)
      .post('/api/lists')
      .send({ userId: 1, url: 'https://letterboxd.com/chris/watchlist/' });

    expect(res.status).toBe(201);
    expect(res.body.listType).toBe('watchlist');
    expect(res.body.label).toBe("Chris's watchlist");
  });

  it('POST rejects an unsupported URL', async () => {
    const res = await request(app).post('/api/lists').send({ userId: 1, url: 'https://example.com/foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supported Letterboxd/);
  });

  it('POST rejects a non-existent user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/lists')
      .send({ userId: 99, url: 'https://letterboxd.com/chris/watchlist/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
  });

  it('POST maps a duplicate (user,url) to 409', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1, name: 'Chris' });
    mockPrisma.list.create.mockRejectedValue(knownError('P2002'));
    const res = await request(app)
      .post('/api/lists')
      .send({ userId: 1, url: 'https://letterboxd.com/chris/watchlist/' });
    expect(res.status).toBe(409);
  });

  it('PATCH re-detects listType when the URL changes', async () => {
    mockPrisma.list.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 3, ...data }));
    const res = await request(app)
      .patch('/api/lists/3')
      .send({ url: 'https://letterboxd.com/films/popular/' });
    expect(res.status).toBe(200);
    expect(mockPrisma.list.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ listType: 'popular_movies' }) })
    );
  });

  it('POST /:id/sync returns the SyncResult', async () => {
    (syncListById as jest.Mock).mockResolvedValue({ listId: 3, status: 'success', added: 2 });
    const res = await request(app).post('/api/lists/3/sync');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ listId: 3, status: 'success' });
    expect(syncListById).toHaveBeenCalledWith(3);
  });

  it('POST /:id/sync maps a disabled/missing list to 400', async () => {
    (syncListById as jest.Mock).mockRejectedValue(new Error('List id=3 not found, disabled, or owner disabled.'));
    const res = await request(app).post('/api/lists/3/sync');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found, disabled/);
  });
});

describe('deletions', () => {
  it('GET defaults to pending', async () => {
    mockPrisma.deletionRequest.findMany.mockResolvedValue([{ id: 1, status: 'pending' }]);
    const res = await request(app).get('/api/deletions');
    expect(res.status).toBe(200);
    expect(mockPrisma.deletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending' } })
    );
  });

  it('GET accepts an explicit status', async () => {
    mockPrisma.deletionRequest.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/deletions?status=kept');
    expect(res.status).toBe(200);
    expect(mockPrisma.deletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'kept' } })
    );
  });

  it('GET rejects an invalid status', async () => {
    const res = await request(app).get('/api/deletions?status=bogus');
    expect(res.status).toBe(400);
  });

  it('POST /:id/approve resolves the request', async () => {
    (approveDeletion as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/deletions/4/approve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 4, status: 'approved' });
    expect(approveDeletion).toHaveBeenCalledWith(4);
  });

  it('POST /:id/approve maps "not found" to 404', async () => {
    (approveDeletion as jest.Mock).mockRejectedValue(new Error('DeletionRequest id=4 not found.'));
    const res = await request(app).post('/api/deletions/4/approve');
    expect(res.status).toBe(404);
  });

  it('POST /:id/approve maps "already" to 409', async () => {
    (approveDeletion as jest.Mock).mockRejectedValue(new Error('DeletionRequest id=4 is already approved.'));
    const res = await request(app).post('/api/deletions/4/approve');
    expect(res.status).toBe(409);
  });

  it('POST /:id/keep pins and resolves', async () => {
    (keepDeletion as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/deletions/4/keep');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 4, status: 'kept' });
  });
});

describe('sync-runs', () => {
  it('GET returns recent runs', async () => {
    mockPrisma.syncRun.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = await request(app).get('/api/sync-runs');
    expect(res.status).toBe(200);
    expect(mockPrisma.syncRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { startedAt: 'desc' }, take: 50 })
    );
  });

  it('GET filters by listId and caps limit', async () => {
    mockPrisma.syncRun.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/sync-runs?listId=7&limit=500');
    expect(res.status).toBe(200);
    expect(mockPrisma.syncRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { listId: 7 }, take: 200 })
    );
  });
});

describe('sync', () => {
  it('POST runs syncAll by default', async () => {
    (syncAll as jest.Mock).mockResolvedValue([{ listId: 1, status: 'success' }]);
    const res = await request(app).post('/api/sync');
    expect(res.status).toBe(200);
    expect(syncAll).toHaveBeenCalled();
    expect(syncDue).not.toHaveBeenCalled();
  });

  it('POST ?due=true runs syncDue', async () => {
    (syncDue as jest.Mock).mockResolvedValue([]);
    const res = await request(app).post('/api/sync?due=true');
    expect(res.status).toBe(200);
    expect(syncDue).toHaveBeenCalled();
    expect(syncAll).not.toHaveBeenCalled();
  });
});
