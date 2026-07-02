const mockPrisma = {
  settings: { findUnique: jest.fn() },
  user: { findUnique: jest.fn(), create: jest.fn() },
  session: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../api/jellyfin', () => ({ __esModule: true, authenticateByName: jest.fn() }));
jest.mock('../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

import { login, logout, validateSession } from './index';
import { authenticateByName } from '../api/jellyfin';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.session.create.mockResolvedValue({});
});

describe('login', () => {
  it('throws when Jellyfin is not configured', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1, jellyfinUrl: null });
    await expect(login('u', 'p')).rejects.toThrow(/not configured/);
    expect(authenticateByName).not.toHaveBeenCalled();
  });

  it('links an existing user and opens a session', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1, jellyfinUrl: 'http://jf' });
    (authenticateByName as jest.Mock).mockResolvedValue({ jellyfinUserId: 'jf-1', name: 'Chris', isAdmin: true });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 5, name: 'Chris', tag: 'chris', jellyfinUserId: 'jf-1' });

    const result = await login('chris', 'pw');

    expect(authenticateByName).toHaveBeenCalledWith('http://jf', 'chris', 'pw');
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(result.user.id).toBe(5);
    expect(result.isAdmin).toBe(true);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(mockPrisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 5, isAdmin: true, token: result.token }),
      })
    );
  });

  it('auto-provisions a new user with a tag derived from the name', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1, jellyfinUrl: 'http://jf' });
    (authenticateByName as jest.Mock).mockResolvedValue({ jellyfinUserId: 'jf-2', name: 'Sam Smith', isAdmin: false });
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null) // no user linked to jf-2
      .mockResolvedValueOnce(null); // tag "sam-smith" is free
    mockPrisma.user.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 6, ...data }));

    const result = await login('sam', 'pw');

    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: { name: 'Sam Smith', jellyfinUserId: 'jf-2', tag: 'sam-smith' },
    });
    expect(result.user.id).toBe(6);
    expect(result.isAdmin).toBe(false);
  });

  it('appends a suffix when the derived tag is taken', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ id: 1, jellyfinUrl: 'http://jf' });
    (authenticateByName as jest.Mock).mockResolvedValue({ jellyfinUserId: 'jf-3', name: 'Chris', isAdmin: false });
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null) // no user linked to jf-3
      .mockResolvedValueOnce({ id: 1, tag: 'chris' }) // "chris" taken
      .mockResolvedValueOnce(null); // "chris-2" free
    mockPrisma.user.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 7, ...data }));

    await login('chris', 'pw');

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tag: 'chris-2' }) })
    );
  });
});

describe('validateSession', () => {
  it('returns null for an empty token', async () => {
    expect(await validateSession('')).toBeNull();
    expect(mockPrisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an unknown token', async () => {
    mockPrisma.session.findUnique.mockResolvedValue(null);
    expect(await validateSession('nope')).toBeNull();
  });

  it('deletes and rejects an expired session', async () => {
    mockPrisma.session.findUnique.mockResolvedValue({
      id: 9,
      expiresAt: new Date(Date.now() - 1000),
      user: { id: 1 },
    });
    mockPrisma.session.delete.mockResolvedValue({});

    expect(await validateSession('old')).toBeNull();
    expect(mockPrisma.session.delete).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(mockPrisma.session.update).not.toHaveBeenCalled();
  });

  it('touches lastSeenAt and returns a valid session', async () => {
    const session = { id: 9, expiresAt: new Date(Date.now() + 100000), user: { id: 1 } };
    mockPrisma.session.findUnique.mockResolvedValue(session);
    mockPrisma.session.update.mockResolvedValue(session);

    const result = await validateSession('good');

    expect(result).toBe(session);
    expect(mockPrisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9 }, data: { lastSeenAt: expect.any(Date) } })
    );
  });
});

describe('logout', () => {
  it('deletes the session by token', async () => {
    mockPrisma.session.deleteMany.mockResolvedValue({ count: 1 });
    await logout('tok');
    expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({ where: { token: 'tok' } });
  });

  it('no-ops on an empty token', async () => {
    await logout('');
    expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
  });
});
