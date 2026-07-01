import { List, Settings, User } from '@prisma/client';

const mockPrisma = {
  settings: { findUnique: jest.fn() },
  syncRun: { create: jest.fn(), update: jest.fn() },
  movie: { upsert: jest.fn() },
  listMovie: { findMany: jest.fn(), upsert: jest.fn() },
  list: { update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../scraper', () => ({ __esModule: true, fetchMoviesFromUrl: jest.fn() }));
jest.mock('../api/radarr', () => ({
  __esModule: true,
  createRadarrClient: jest.fn(() => ({})),
  upsertMovies: jest.fn(),
}));
jest.mock('../reconcile', () => ({ __esModule: true, reconcileList: jest.fn(), reconcileWatched: jest.fn() }));
jest.mock('../watched', () => ({ __esModule: true, getOwnerWatchedTmdbIds: jest.fn() }));
jest.mock('../collections', () => ({ __esModule: true, syncCollection: jest.fn() }));
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { syncList } from './index';
import { fetchMoviesFromUrl } from '../scraper';
import { upsertMovies } from '../api/radarr';
import { reconcileList, reconcileWatched } from '../reconcile';
import { getOwnerWatchedTmdbIds } from '../watched';
import { syncCollection } from '../collections';
import { ListWithUser } from '../db/config';

const now = new Date('2026-01-01T00:00:00Z');

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
    permanence: false,
    unwatchedOnly: false,
    removeOnWatch: false,
    makeCollection: false,
    collectionNameOverride: null,
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return { ...list, user };
}

const movieA = { id: 1, name: 'A', slug: '/film/a/', tmdbId: '1', imdbId: null, publishedYear: 2020 };
const movieB = { id: 2, name: 'B', slug: '/film/b/', tmdbId: '2', imdbId: null, publishedYear: 2021 };

describe('syncList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.syncRun.create.mockResolvedValue({ id: 99 });
    mockPrisma.syncRun.update.mockResolvedValue({});
    mockPrisma.listMovie.findMany.mockResolvedValue([]);
    mockPrisma.movie.upsert.mockImplementation(({ where, create }: any) =>
      Promise.resolve({ id: where.tmdbId, ...create })
    );
    mockPrisma.listMovie.upsert.mockResolvedValue({});
    mockPrisma.list.update.mockResolvedValue({});
    (reconcileList as jest.Mock).mockResolvedValue(undefined);
    (reconcileWatched as jest.Mock).mockResolvedValue(undefined);
    (getOwnerWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set());
    (syncCollection as jest.Mock).mockResolvedValue(undefined);
  });

  it('scrapes, adds, records Movie/ListMovie rows, and marks the run success', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA, movieB]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 2,
      skipped: 0,
      failed: 0,
      results: [
        { movie: movieA, status: 'added', radarrMovieId: 100 },
        { movie: movieB, status: 'added', radarrMovieId: 101 },
      ],
    });

    const result = await syncList(makeList());

    expect(result).toMatchObject({ status: 'success', found: 2, added: 2, failed: 0 });
    expect(mockPrisma.movie.upsert).toHaveBeenCalledTimes(2);
    expect(mockPrisma.movie.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tmdbId: 1 },
        create: expect.objectContaining({ tmdbId: 1, addedByFilmstrip: true, radarrMovieId: 100 }),
      })
    );
    expect(mockPrisma.listMovie.upsert).toHaveBeenCalledTimes(2);
    expect(reconcileList).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), new Set([1, 2]));
    expect(mockPrisma.syncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 99 },
        data: expect.objectContaining({ status: 'success', moviesFound: 2, moviesAdded: 2 }),
      })
    );
    expect(mockPrisma.list.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncedAt: expect.any(Date) }) })
    );
  });

  it('dedups already-synced movies before upserting', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movie: { tmdbId: 1 } }]);
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA, movieB]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieB, status: 'added', radarrMovieId: 101 }],
    });

    const result = await syncList(makeList());

    // Only the unseen movie is passed to Radarr.
    expect(upsertMovies).toHaveBeenCalledWith(expect.anything(), [movieB], expect.anything());
    // alreadySynced (1) folds into the skipped count.
    expect(result).toMatchObject({ found: 2, added: 1, skipped: 1 });
  });

  it('does not write Movie/ListMovie rows in dry-run mode', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings({ dryRun: true }));
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieA, status: 'dryRun' }],
    });

    const result = await syncList(makeList());

    expect(result.dryRun).toBe(true);
    expect(mockPrisma.movie.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.listMovie.upsert).not.toHaveBeenCalled();
    expect(reconcileList).not.toHaveBeenCalled();
  });

  it('does not fetch watched state when neither unwatchedOnly nor removeOnWatch is on', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieA, status: 'added', radarrMovieId: 100 }],
    });

    await syncList(makeList());

    expect(getOwnerWatchedTmdbIds).not.toHaveBeenCalled();
  });

  it('unwatchedOnly excludes already-watched movies from the add pipeline but not from reconcile', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA, movieB]);
    (getOwnerWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set([1])); // movieA already watched
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieB, status: 'added', radarrMovieId: 101 }],
    });

    const result = await syncList(makeList({ unwatchedOnly: true }));

    expect(upsertMovies).toHaveBeenCalledWith(expect.anything(), [movieB], expect.anything());
    // movieA folds into skipped even though it was never attempted.
    expect(result).toMatchObject({ found: 2, added: 1, skipped: 1 });
    // reconcileList still sees the full raw scrape (movieA hasn't left the actual list).
    expect(reconcileList).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), new Set([1, 2]));
  });

  it('removeOnWatch queues review for watched films still on the list', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (getOwnerWatchedTmdbIds as jest.Mock).mockResolvedValue(new Set([1]));
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 0,
      skipped: 1,
      failed: 0,
      results: [{ movie: movieA, status: 'skipped', reason: 'already in Radarr' }],
    });

    await syncList(makeList({ removeOnWatch: true }));

    expect(reconcileWatched).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), new Set([1]));
  });

  it('does not call reconcileWatched when removeOnWatch is off', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieA, status: 'added', radarrMovieId: 100 }],
    });

    await syncList(makeList());

    expect(reconcileWatched).not.toHaveBeenCalled();
  });

  it('syncs a Jellyfin collection when makeCollection is on', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieA, status: 'added', radarrMovieId: 100 }],
    });

    await syncList(makeList({ makeCollection: true, collectionNameOverride: 'Horror Picks' }));

    expect(syncCollection).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), 'Horror Picks');
  });

  it('does not fail the sync when collection sync throws', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieA, status: 'added', radarrMovieId: 100 }],
    });
    (syncCollection as jest.Mock).mockRejectedValue(new Error('jellyfin boom'));

    const result = await syncList(makeList({ makeCollection: true }));

    expect(result.status).toBe('success');
  });

  it('does not fail the sync when reconcile throws', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 0,
      results: [{ movie: movieA, status: 'added', radarrMovieId: 100 }],
    });
    (reconcileList as jest.Mock).mockRejectedValue(new Error('reconcile boom'));

    const result = await syncList(makeList());

    expect(result.status).toBe('success');
  });

  it('marks the run partial when some movies fail', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA, movieB]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 1,
      skipped: 0,
      failed: 1,
      results: [
        { movie: movieA, status: 'added', radarrMovieId: 100 },
        { movie: movieB, status: 'failed', reason: 'boom' },
      ],
    });

    const result = await syncList(makeList());

    expect(result.status).toBe('partial');
    // 'failed' outcomes are not recorded, so they retry next run.
    expect(mockPrisma.movie.upsert).toHaveBeenCalledTimes(1);
  });

  it('marks an existing film as not added-by-filmstrip when Radarr reports it already exists', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockResolvedValue([movieA]);
    (upsertMovies as jest.Mock).mockResolvedValue({
      added: 0,
      skipped: 1,
      failed: 0,
      results: [{ movie: movieA, status: 'skipped', reason: 'already in Radarr' }],
    });

    await syncList(makeList());

    expect(mockPrisma.movie.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ addedByFilmstrip: false }),
      })
    );
  });

  it('records a failed run when scraping throws', async () => {
    (fetchMoviesFromUrl as jest.Mock).mockRejectedValue(new Error('letterboxd down'));

    const result = await syncList(makeList());

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/letterboxd down/);
    expect(mockPrisma.syncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) })
    );
  });
});
