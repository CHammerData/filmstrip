import { Settings, User } from '@prisma/client';

jest.mock('../scraper', () => ({ __esModule: true, fetchMoviesFromUrl: jest.fn() }));
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

import { getOwnerWatchedTmdbIds } from './index';
import { fetchMoviesFromUrl } from '../scraper';
import { getWatchedTmdbIds } from '../api/jellyfin';

const now = new Date('2026-01-01T00:00:00Z');

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: 'Chris',
    tag: 'chris',
    enabled: true,
    letterboxdUsername: null,
    jellyfinUserId: null,
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
