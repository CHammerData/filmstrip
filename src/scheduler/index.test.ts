import { List, Settings, User } from '@prisma/client';

const mockPrisma = {
  settings: { findUnique: jest.fn() },
  syncRun: { create: jest.fn(), update: jest.fn() },
  syncedMovie: { findMany: jest.fn(), create: jest.fn() },
  list: { update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../scraper', () => ({ __esModule: true, fetchMoviesFromUrl: jest.fn() }));
jest.mock('../api/radarr', () => ({
  __esModule: true,
  createRadarrClient: jest.fn(() => ({})),
  upsertMovies: jest.fn(),
}));
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { syncList } from './index';
import { fetchMoviesFromUrl } from '../scraper';
import { upsertMovies } from '../api/radarr';
import { ListWithUser } from '../db/config';

const now = new Date('2026-01-01T00:00:00Z');

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: 1,
    radarrUrl: 'http://radarr:7878',
    radarrApiKey: 'key',
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

function makeList(): ListWithUser {
  const user: User = { id: 1, name: 'Chris', tag: 'chris', enabled: true, createdAt: now, updatedAt: now };
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
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
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
    mockPrisma.syncedMovie.findMany.mockResolvedValue([]);
    mockPrisma.syncedMovie.create.mockResolvedValue({});
    mockPrisma.list.update.mockResolvedValue({});
  });

  it('scrapes, adds, records SyncedMovie rows, and marks the run success', async () => {
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
    expect(mockPrisma.syncedMovie.create).toHaveBeenCalledTimes(2);
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
    mockPrisma.syncedMovie.findMany.mockResolvedValue([{ letterboxdSlug: '/film/a/' }]);
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

  it('does not write SyncedMovie rows in dry-run mode', async () => {
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
    expect(mockPrisma.syncedMovie.create).not.toHaveBeenCalled();
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
    expect(mockPrisma.syncedMovie.create).toHaveBeenCalledTimes(1);
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
