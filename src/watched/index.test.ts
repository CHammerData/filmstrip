import { Settings, User } from '@prisma/client';

const mockPrisma: any = {
  watchedFilm: { upsert: jest.fn(), findMany: jest.fn() },
  user: { update: jest.fn(), findMany: jest.fn() },
  settings: { findUnique: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../scraper', () => ({ __esModule: true, fetchMoviesFromUrl: jest.fn() }));
jest.mock('../scraper/diary', () => ({
  __esModule: true,
  DiaryScraper: jest.fn().mockImplementation(() => ({ getEntries: jest.fn() })),
}));
jest.mock('../api/jellyfin', () => ({
  __esModule: true,
  createJellyfinClient: jest.fn(() => ({})),
  getWatchedTmdbIds: jest.fn(),
}));
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { getOwnerWatchedTmdbIds, refreshWatchedState, refreshDueUsers, getDiaryWatchedDates } from './index';
import { fetchMoviesFromUrl } from '../scraper';
import { DiaryScraper } from '../scraper/diary';
import { getWatchedTmdbIds } from '../api/jellyfin';

/** Configure the mocked DiaryScraper's next getEntries() call. */
function mockDiaryEntries(entries: { tmdbId: string; watchedAt: Date }[]) {
  (DiaryScraper as jest.Mock).mockImplementation(() => ({
    getEntries: jest.fn().mockResolvedValue(entries),
  }));
}

const now = new Date('2026-01-01T00:00:00Z');

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: 'Chris',
    tag: 'chris',
    enabled: true,
    letterboxdUsername: null,
    jellyfinUserId: null,
    lastWatchedRefreshAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: 1,
    radarrUrl: 'http://radarr:7878',
    radarrApiKey: 'key',
    jellyfinUrl: null,
    jellyfinApiKey: null,
    defaultQualityProfile: 'HD-1080p',
    defaultRootFolderId: null,
    defaultMinimumAvailability: 'released',
    defaultCheckIntervalMin: 60,
    dryRun: false,
    watchedRefreshIntervalMin: 1440,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('getOwnerWatchedTmdbIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty set when neither source is configured', async () => {
    const result = await getOwnerWatchedTmdbIds(makeUser(), makeSettings());

    expect(result).toEqual(new Set());
    expect(fetchMoviesFromUrl).not.toHaveBeenCalled();
    expect(getWatchedTmdbIds).not.toHaveBeenCalled();
  });

  it('scrapes the Letterboxd /films/ page when letterboxdUsername is set', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([
      { id: 1, name: 'A', slug: '/film/a/', tmdbId: '100' },
      { id: 2, name: 'B', slug: '/film/b/', tmdbId: null },
    ]);

    const result = await getOwnerWatchedTmdbIds(makeUser({ letterboxdUsername: 'chris' }), makeSettings());

    expect(fetchMoviesFromUrl).toHaveBeenCalledWith('https://letterboxd.com/chris/films/');
    expect(result).toEqual(new Set([100]));
  });

  it('degrades to empty when the Letterboxd scrape fails', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockRejectedValue(new Error('letterboxd down'));

    const result = await getOwnerWatchedTmdbIds(makeUser({ letterboxdUsername: 'chris' }), makeSettings());

    expect(result).toEqual(new Set());
  });

  it('queries Jellyfin when jellyfinUserId and the connection are configured', async () => {
    (getWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set([200]));

    const result = await getOwnerWatchedTmdbIds(
      makeUser({ jellyfinUserId: 'user-1' }),
      makeSettings({ jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'key' })
    );

    expect(getWatchedTmdbIds).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(result).toEqual(new Set([200]));
  });

  it('skips Jellyfin when jellyfinUserId is set but Settings has no connection', async () => {
    const result = await getOwnerWatchedTmdbIds(makeUser({ jellyfinUserId: 'user-1' }), makeSettings());

    expect(getWatchedTmdbIds).not.toHaveBeenCalled();
    expect(result).toEqual(new Set());
  });

  it('unions Letterboxd and Jellyfin watched sets', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([
      { id: 1, name: 'A', slug: '/film/a/', tmdbId: '100' },
    ]);
    (getWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set([200]));

    const result = await getOwnerWatchedTmdbIds(
      makeUser({ letterboxdUsername: 'chris', jellyfinUserId: 'user-1' }),
      makeSettings({ jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'key' })
    );

    expect(result).toEqual(new Set([100, 200]));
  });
});

describe('getDiaryWatchedDates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a map of tmdbId to watchedAt for letterboxd_diary rows', async () => {
    mockPrisma.watchedFilm.findMany.mockResolvedValue([
      { tmdbId: 100, watchedAt: new Date('2026-07-15T00:00:00Z') },
    ]);

    const result = await getDiaryWatchedDates(1);

    expect(mockPrisma.watchedFilm.findMany).toHaveBeenCalledWith({
      where: { userId: 1, source: 'letterboxd_diary', watchedAt: { not: null } },
      select: { tmdbId: true, watchedAt: true },
    });
    expect(result).toEqual(new Map([[100, new Date('2026-07-15T00:00:00Z')]]));
  });

  it('returns an empty map when there are no diary rows', async () => {
    mockPrisma.watchedFilm.findMany.mockResolvedValue([]);

    const result = await getDiaryWatchedDates(1);

    expect(result.size).toBe(0);
  });
});

describe('refreshWatchedState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDiaryEntries([]);
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
    (getWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set());
    mockPrisma.watchedFilm.upsert.mockResolvedValue({});
    mockPrisma.user.update.mockResolvedValue({});
  });

  it('upserts a diary-dated film with source letterboxd_diary', async () => {
    mockDiaryEntries([{ tmdbId: '127380', watchedAt: new Date('2026-07-15T00:00:00Z') }]);

    await refreshWatchedState(makeUser({ letterboxdUsername: 'chris' }), makeSettings());

    expect(mockPrisma.watchedFilm.upsert).toHaveBeenCalledWith({
      where: { userId_tmdbId: { userId: 1, tmdbId: 127380 } },
      update: { watchedAt: new Date('2026-07-15T00:00:00Z'), source: 'letterboxd_diary' },
      create: { userId: 1, tmdbId: 127380, watchedAt: new Date('2026-07-15T00:00:00Z'), source: 'letterboxd_diary' },
    });
  });

  it('upserts a watched-but-undiaried film with a null date and source letterboxd_aggregate', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([{ id: 1, name: 'A', slug: '/film/a/', tmdbId: '100' }]);

    await refreshWatchedState(makeUser({ letterboxdUsername: 'chris' }), makeSettings());

    expect(mockPrisma.watchedFilm.upsert).toHaveBeenCalledWith({
      where: { userId_tmdbId: { userId: 1, tmdbId: 100 } },
      update: { watchedAt: null, source: 'letterboxd_aggregate' },
      create: { userId: 1, tmdbId: 100, watchedAt: null, source: 'letterboxd_aggregate' },
    });
  });

  it('upserts a Jellyfin-only watched film with a null date and source jellyfin', async () => {
    (getWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set([200]));

    await refreshWatchedState(
      makeUser({ jellyfinUserId: 'user-1' }),
      makeSettings({ jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'key' })
    );

    expect(mockPrisma.watchedFilm.upsert).toHaveBeenCalledWith({
      where: { userId_tmdbId: { userId: 1, tmdbId: 200 } },
      update: { watchedAt: null, source: 'jellyfin' },
      create: { userId: 1, tmdbId: 200, watchedAt: null, source: 'jellyfin' },
    });
  });

  it('lets a diary date upgrade a presence-only record for the same film', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([{ id: 1, name: 'A', slug: '/film/a/', tmdbId: '100' }]);
    mockDiaryEntries([{ tmdbId: '100', watchedAt: new Date('2026-07-15T00:00:00Z') }]);

    await refreshWatchedState(makeUser({ letterboxdUsername: 'chris' }), makeSettings());

    expect(mockPrisma.watchedFilm.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.watchedFilm.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { watchedAt: new Date('2026-07-15T00:00:00Z'), source: 'letterboxd_diary' } })
    );
  });

  it('keeps the most recent date across multiple diary entries for the same film (a rewatch)', async () => {
    mockDiaryEntries([
      { tmdbId: '100', watchedAt: new Date('2026-01-01T00:00:00Z') },
      { tmdbId: '100', watchedAt: new Date('2026-07-15T00:00:00Z') },
    ]);

    await refreshWatchedState(makeUser({ letterboxdUsername: 'chris' }), makeSettings());

    expect(mockPrisma.watchedFilm.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.watchedFilm.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { watchedAt: new Date('2026-07-15T00:00:00Z'), source: 'letterboxd_diary' } })
    );
  });

  it('records lastWatchedRefreshAt on the user', async () => {
    await refreshWatchedState(makeUser(), makeSettings());

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { lastWatchedRefreshAt: expect.any(Date) },
    });
  });
});

describe('refreshDueUsers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDiaryEntries([]);
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([]);
    (getWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set());
    mockPrisma.watchedFilm.upsert.mockResolvedValue({});
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings({ watchedRefreshIntervalMin: 60 }));
  });

  it('does nothing when there is no Settings row', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([makeUser()]);

    await refreshDueUsers();

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('refreshes a user who has never been refreshed', async () => {
    mockPrisma.user.findMany.mockResolvedValue([makeUser({ lastWatchedRefreshAt: null })]);

    await refreshDueUsers();

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastWatchedRefreshAt: expect.any(Date) } })
    );
  });

  it('skips a user whose refresh interval has not elapsed yet', async () => {
    const recentlyRefreshed = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago, interval is 60 min
    mockPrisma.user.findMany.mockResolvedValue([makeUser({ lastWatchedRefreshAt: recentlyRefreshed })]);

    await refreshDueUsers();

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('refreshes a user whose refresh interval has elapsed', async () => {
    const longAgo = new Date(Date.now() - 120 * 60 * 1000); // 2h ago, interval is 60 min
    mockPrisma.user.findMany.mockResolvedValue([makeUser({ lastWatchedRefreshAt: longAgo })]);

    await refreshDueUsers();

    expect(mockPrisma.user.update).toHaveBeenCalled();
  });

  it('does not throw when one user fails, and still refreshes the rest', async () => {
    mockPrisma.user.findMany.mockResolvedValue([makeUser({ id: 1 }), makeUser({ id: 2 })]);
    mockPrisma.user.update.mockRejectedValueOnce(new Error('db boom')).mockResolvedValueOnce({});

    await expect(refreshDueUsers()).resolves.toBeUndefined();
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(2);
  });
});
