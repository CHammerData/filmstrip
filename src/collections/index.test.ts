import { List, Settings, User, Movie } from '@prisma/client';

const mockPrisma = {
  settings: { findUnique: jest.fn() },
  listMovie: { findMany: jest.fn() },
  movie: { update: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../api/jellyfin', () => ({
  __esModule: true,
  createJellyfinClient: jest.fn(() => ({})),
  getAllMovieProviderIds: jest.fn(),
  findCollectionByName: jest.fn(),
  createCollection: jest.fn(),
  getCollectionItemIds: jest.fn(),
  addToCollection: jest.fn(),
  removeFromCollection: jest.fn(),
}));
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { syncCollection } from './index';
import {
  getAllMovieProviderIds,
  findCollectionByName,
  createCollection,
  getCollectionItemIds,
  addToCollection,
  removeFromCollection,
} from '../api/jellyfin';
import { ListWithUser } from '../db/config';

const now = new Date('2026-01-01T00:00:00Z');

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: 1,
    radarrUrl: 'http://radarr:7878',
    radarrApiKey: 'key',
    jellyfinUrl: 'http://jellyfin:8096',
    jellyfinApiKey: 'jf-key',
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

function makeList(overrides: Partial<List> = {}): ListWithUser {
  const user: User = {
    id: 1,
    name: 'Chris',
    tag: 'chris',
    enabled: true,
    letterboxdUsername: null,
    jellyfinUserId: null,
    createdAt: now,
    updatedAt: now,
  };
  const list: List = {
    id: 10,
    userId: 1,
    url: 'https://letterboxd.com/chris/watchlist/',
    listType: 'watchlist',
    label: "Chris's watchlist",
    enabled: true,
    qualityProfile: null,
    rootFolderId: null,
    minimumAvailability: null,
    monitored: true,
    extraTags: null,
    takeAmount: null,
    takeStrategy: null,
    checkIntervalMin: null,
    deleteFiles: true,
    unwatchedOnly: false,
    removeOnWatch: false,
    makeCollection: true,
    collectionNameOverride: null,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return { ...list, user };
}

function makeMovie(overrides: Partial<Movie> = {}): Movie {
  return {
    id: 1,
    tmdbId: 100,
    imdbId: null,
    title: 'A Movie',
    year: 2020,
    addedByFilmstrip: true,
    radarrMovieId: 500,
    jellyfinItemId: null,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('syncCollection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.movie.update.mockResolvedValue({});
    (getAllMovieProviderIds as jest.Mock).mockResolvedValue([{ id: 'jf-1', tmdbId: 100 }]);
  });

  it('warns and skips when Jellyfin is not configured', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings({ jellyfinUrl: null }));
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movie: makeMovie() }]);

    await syncCollection(makeList(), "Chris's watchlist");

    expect(findCollectionByName).not.toHaveBeenCalled();
  });

  it('creates a new collection when none exists', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movie: makeMovie() }]);
    (findCollectionByName as jest.Mock).mockResolvedValue(null);
    (createCollection as jest.Mock).mockResolvedValue({ id: 'col-1' });

    await syncCollection(makeList(), "Chris's watchlist");

    expect(createCollection).toHaveBeenCalledWith(expect.anything(), "Chris's watchlist", ['jf-1']);
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { jellyfinItemId: 'jf-1' },
    });
  });

  it('does not create an empty collection', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([]);
    (findCollectionByName as jest.Mock).mockResolvedValue(null);

    await syncCollection(makeList(), "Chris's watchlist");

    expect(createCollection).not.toHaveBeenCalled();
  });

  it('diffs membership against an existing collection', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movie: makeMovie({ id: 1, tmdbId: 100, jellyfinItemId: 'jf-1' }) },
    ]);
    (findCollectionByName as jest.Mock).mockResolvedValue({ id: 'col-1' });
    (getCollectionItemIds as jest.Mock).mockResolvedValue(['jf-1', 'jf-stale']);

    await syncCollection(makeList(), "Chris's watchlist");

    // jf-1 already a member (no add); jf-stale no longer belongs (remove).
    expect(addToCollection).toHaveBeenCalledWith(expect.anything(), 'col-1', []);
    expect(removeFromCollection).toHaveBeenCalledWith(expect.anything(), 'col-1', ['jf-stale']);
    // Already cached on the Movie row -- no need to re-fetch the whole library.
    expect(getAllMovieProviderIds).not.toHaveBeenCalled();
  });

  it('reuses a cached jellyfinItemId without re-fetching the library', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movie: makeMovie({ jellyfinItemId: 'jf-cached' }) },
    ]);
    (findCollectionByName as jest.Mock).mockResolvedValue({ id: 'col-1' });
    (getCollectionItemIds as jest.Mock).mockResolvedValue(['jf-cached']);

    await syncCollection(makeList(), "Chris's watchlist");

    expect(getAllMovieProviderIds).not.toHaveBeenCalled();
    // Membership already matches -- no-op, no add/remove calls.
    expect(addToCollection).not.toHaveBeenCalled();
    expect(removeFromCollection).not.toHaveBeenCalled();
  });
});
