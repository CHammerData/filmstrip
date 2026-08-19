import { Settings, List, User, Movie, DeletionRequest } from '@prisma/client';

const mockPrisma: any = {
  settings: { findUnique: jest.fn() },
  user: { findMany: jest.fn() },
  list: { findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
  movie: { findUnique: jest.fn(), update: jest.fn() },
  movieEvent: { create: jest.fn(), findFirst: jest.fn() },
  listMovie: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  deletionRequest: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  // evaluateForDeletion (and other transitions) re-check-and-write inside a transaction to close a
  // race window; running the callback against mockPrisma itself keeps every mock shared as-is.
  $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(mockPrisma)),
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../api/radarr', () => ({
  __esModule: true,
  createRadarrClient: jest.fn(() => ({})),
  getMovieById: jest.fn(),
  getMovieByTmdbId: jest.fn(),
  getAllTags: jest.fn(),
  setMonitored: jest.fn(),
  deleteMovie: jest.fn(),
}));
jest.mock('../api/jellyfin', () => ({
  __esModule: true,
  createJellyfinClient: jest.fn(() => ({})),
  deleteCollection: jest.fn(),
}));
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../watched', () => ({
  __esModule: true,
  getDiaryWatchedDates: jest.fn(),
}));

import {
  reconcileList,
  reconcileWatched,
  deleteList,
  approveDeletion,
  keepDeletion,
  applyPermanenceClaims,
  handleListDisabled,
  dropKeepStatus,
  convertToManaged,
  getSoleOwnerUserId,
} from './index';
import { getMovieById, getMovieByTmdbId, getAllTags, setMonitored, deleteMovie } from '../api/radarr';
import { deleteCollection } from '../api/jellyfin';
import { getDiaryWatchedDates } from '../watched';
import { ListWithUser } from '../db/config';

const now = new Date('2026-01-01T00:00:00Z');

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: 1,
    radarrUrl: 'http://radarr:7878',
    radarrApiKey: 'key',
    jellyfinUrl: null,
    jellyfinApiKey: null,
    flaresolverrUrl: null,
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

function makeList(overrides: Partial<List> = {}): ListWithUser {
  const user: User = {
    id: 1,
    name: 'Chris',
    tag: 'chris',
    enabled: true,
    letterboxdUsername: null,
    jellyfinUserId: null,
    lastWatchedRefreshAt: null,
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
    permanence: false,
    unwatchedOnly: false,
    removeOnWatch: false,
    makeCollection: false,
    collectionNameOverride: null,
    jellyfinCollectionId: null,
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
    state: 'added',
    radarrMovieId: 500,
    jellyfinItemId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('reconcileList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([{ tag: 'chris' }]);
    mockPrisma.list.findMany.mockResolvedValue([{ extraTags: null }]);
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.listMovie.update.mockResolvedValue({});
    mockPrisma.listMovie.findFirst.mockResolvedValue(null); // nothing else wants it, by default
    mockPrisma.deletionRequest.findMany.mockResolvedValue([]); // no stale left_list requests, by default
    mockPrisma.deletionRequest.create.mockResolvedValue({});
    (getMovieById as jest.Mock).mockResolvedValue({
      id: 500,
      title: 'A Movie',
      tags: [],
    });
    (getAllTags as jest.Mock).mockResolvedValue([
      { id: 1, label: 'chris' },
      { id: 2, label: 'letterboxd' },
    ]);
    (setMonitored as jest.Mock).mockResolvedValue(undefined);
  });

  it('does nothing when every tracked movie is still on the list', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.listMovie.update).not.toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('marks a dropped-off movie not present, transitions it to deletion_queued, and opens a DeletionRequest', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.listMovie.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { presentOnList: false, removedFromListAt: expect.any(Date) },
    });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'left_list', listId: 10 },
    });
    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'deletion_queued' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'deletion_queued', detail: 'left_list', listId: 10 },
    });
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'left_list', triggeredByListId: 10, status: 'pending' },
    });
  });

  it('restores a previously-dropped movie that has reappeared in the scrape', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: false, movie: { tmdbId: 100 } },
    ]);

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.listMovie.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { presentOnList: true, removedFromListAt: null, lastSeenAt: expect.any(Date) },
    });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'restored_to_list', listId: 10 },
    });
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('revives a deleted movie to wanted when it reappears on a list', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: false, movie: { tmdbId: 100, state: 'deleted' } },
    ]);

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'wanted' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: {
        movieId: 1,
        type: 'revived',
        detail: 'reappeared on a list after being deleted -- will be retried',
        listId: 10,
      },
    });
  });

  it('does not revive a kept movie when it reappears on a list', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: false, movie: { tmdbId: 100, state: 'kept' } },
    ]);

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.movie.update).not.toHaveBeenCalled();
    expect(mockPrisma.movieEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'revived' }) })
    );
  });

  it('refuses to drop the majority of a list at once, treating it as a broken scrape', async () => {
    // 3 of 4 currently-tracked films missing from this scrape -- above both the minimum count
    // and the ratio threshold -- should be skipped rather than trusted.
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
      { id: 2, movieId: 2, presentOnList: true, movie: { tmdbId: 200 } },
      { id: 3, movieId: 3, presentOnList: true, movie: { tmdbId: 300 } },
      { id: 4, movieId: 4, presentOnList: true, movie: { tmdbId: 400 } },
    ]);

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.listMovie.update).not.toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('still drops a small number of films even when that is more than half the list', async () => {
    // Only 2 tracked films total -- below MASS_DROP_MIN_COUNT -- so a single legitimate
    // removal (the overwhelmingly common real edit) must never be blocked by the guard.
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
      { id: 2, movieId: 2, presentOnList: true, movie: { tmdbId: 200 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.listMovie.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { presentOnList: false, removedFromListAt: expect.any(Date) },
    });
  });

  it('cancels a stale pending left_list request for a film confirmed still claimed, and re-monitors it', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.deletionRequest.findMany.mockResolvedValue([
      { id: 9, movieId: 1, status: 'pending', reason: 'left_list' },
    ]);
    mockPrisma.listMovie.findFirst.mockResolvedValue({ id: 2 }); // hasClaim: still claimed
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'deletion_queued' }));

    await reconcileList(makeList(), new Set([100]));

    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), true);
    expect(mockPrisma.deletionRequest.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [9] } } });
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'added' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'deletion_queue_cancelled', detail: 'confirmed still claimed' },
    });
  });

  it('does not cancel a stale pending left_list request when no claim has reappeared', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.deletionRequest.findMany.mockResolvedValue([
      { id: 9, movieId: 1, status: 'pending', reason: 'left_list' },
    ]);
    // listMovie.findFirst defaults to null (beforeEach) -- no claim.

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.deletionRequest.deleteMany).not.toHaveBeenCalled();
  });

  it('checks left_list/list_deleted/list_deactivated/manual_reopen/watched pending requests for staleness', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.deletionRequest.findMany).toHaveBeenCalledWith({
      where: {
        movieId: 1,
        status: 'pending',
        reason: { in: ['left_list', 'list_deleted', 'list_deactivated', 'manual_reopen', 'watched'] },
      },
    });
  });

  it('does not create a duplicate DeletionRequest if the movie is queued by someone else between the early check and the transaction', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique
      .mockResolvedValueOnce(makeMovie()) // early check: state 'added'
      .mockResolvedValueOnce(makeMovie({ state: 'deletion_queued' })); // re-check inside the transaction: lost the race

    await reconcileList(makeList(), new Set());

    expect(setMonitored).toHaveBeenCalled(); // the unmonitor call itself is harmless/idempotent
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not open a DeletionRequest for a film not in "added" state (e.g. pre_existing)', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'pre_existing' }));

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.listMovie.update).toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not open a DeletionRequest for a kept film', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'kept' }));

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not open a DeletionRequest when another enabled list still wants the film', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());
    mockPrisma.listMovie.findFirst.mockResolvedValue({ id: 2 }); // still present on some other list

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(setMonitored).not.toHaveBeenCalled();
  });

  it('claim check excludes film-level excluded ListMovie rows', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.listMovie.findFirst).toHaveBeenCalledWith({
      where: { presentOnList: true, excluded: false, movieId: 1, list: { enabled: true } },
    });
  });

  it('never touches a film carrying a foreign Radarr tag', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [1, 99] });
    (getAllTags as jest.Mock).mockResolvedValue([
      { id: 1, label: 'chris' },
      { id: 99, label: 'seerr' }, // not a known Filmstrip tag
    ]);

    await reconcileList(makeList(), new Set());

    expect(setMonitored).not.toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('backfills a missing radarrMovieId by looking the film up in Radarr by tmdbId, then proceeds', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ radarrMovieId: null }));
    (getMovieByTmdbId as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tmdbId: 100, tags: [] });

    await reconcileList(makeList(), new Set());

    expect(getMovieByTmdbId).toHaveBeenCalledWith(expect.anything(), 100);
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { radarrMovieId: 500 } });
    expect(getMovieById).toHaveBeenCalledWith(expect.anything(), 500);
    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'left_list', triggeredByListId: 10, status: 'pending' },
    });
  });

  it('gives up (no crash, no queue) when radarrMovieId is missing and the film cannot be found in Radarr by tmdbId either', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ radarrMovieId: null }));
    (getMovieByTmdbId as jest.Mock).mockResolvedValue(null);

    await expect(reconcileList(makeList(), new Set())).resolves.toBeUndefined();

    expect(mockPrisma.movie.update).not.toHaveBeenCalled();
    expect(setMonitored).not.toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('skips a film already queued for deletion', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'deletion_queued' }));

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not throw when evaluating one movie fails, and still updates presentOnList', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, presentOnList: true, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockRejectedValue(new Error('db boom'));

    await expect(reconcileList(makeList(), new Set())).resolves.toBeUndefined();
    expect(mockPrisma.listMovie.update).toHaveBeenCalled();
  });
});

describe('reconcileWatched', () => {
  const before = new Date('2025-06-01T00:00:00Z');
  const after = new Date('2026-06-01T00:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([{ tag: 'chris' }]);
    mockPrisma.list.findMany.mockResolvedValue([{ extraTags: null }]);
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.deletionRequest.create.mockResolvedValue({});
    mockPrisma.listMovie.findFirst.mockResolvedValue(null); // hasOrdinaryClaim: no other claim, by default
    mockPrisma.movieEvent.findFirst.mockResolvedValue(null); // no prior watch_dropped event, by default
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [] });
    (getAllTags as jest.Mock).mockResolvedValue([{ id: 1, label: 'chris' }]);
    (setMonitored as jest.Mock).mockResolvedValue(undefined);
  });

  it('does nothing when there are no diary watch dates', async () => {
    await reconcileWatched(makeList(), new Map());

    expect(mockPrisma.listMovie.findMany).not.toHaveBeenCalled();
  });

  it('logs watch_dropped and queues a claimed film watched after this list started tracking it', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: before, movie: { tmdbId: 100, state: 'added' } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileWatched(makeList(), new Map([[100, after]]));

    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: {
        movieId: 1,
        type: 'watch_dropped',
        listId: 10,
        detail: 'owner watched this film; list "Chris\'s watchlist" (removeOnWatch) drops its claim',
      },
    });
    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'watched', triggeredByListId: 10, status: 'pending' },
    });
  });

  it('ignores a film with no diary watch date', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: before, movie: { tmdbId: 100, state: 'added' } },
    ]);

    await reconcileWatched(makeList(), new Map([[999, after]]));

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.movieEvent.create).not.toHaveBeenCalled();
  });

  it('ignores a diary watch date that predates this list tracking the film', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: after, movie: { tmdbId: 100, state: 'added' } },
    ]);

    await reconcileWatched(makeList(), new Map([[100, before]]));

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.movieEvent.create).not.toHaveBeenCalled();
  });

  it('queues a film added and diary-logged on the same calendar day (firstSeenAt has a later time-of-day than the diary\'s midnight-UTC date)', async () => {
    const addedLaterSameDay = new Date('2026-06-01T14:00:00Z');
    const diaryMidnightSameDay = new Date('2026-06-01T00:00:00Z');
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: addedLaterSameDay, movie: { tmdbId: 100, state: 'added' } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileWatched(makeList(), new Map([[100, diaryMidnightSameDay]]));

    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'watched', triggeredByListId: 10, status: 'pending' },
    });
  });

  it('defers to another enabled, non-removeOnWatch list that still ordinarily claims the film', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: before, movie: { tmdbId: 100, state: 'added' } },
    ]);
    mockPrisma.listMovie.findFirst.mockResolvedValue({ id: 2 }); // hasOrdinaryClaim: yes

    await reconcileWatched(makeList(), new Map([[100, after]]));

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.movieEvent.create).not.toHaveBeenCalled();
  });

  it('does not log or attempt evaluation for a film that has already left added (e.g. kept) -- nothing left to drop', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: before, movie: { tmdbId: 100, state: 'kept' } },
    ]);

    await reconcileWatched(makeList(), new Map([[100, after]]));

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.movieEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.movie.findUnique).not.toHaveBeenCalled(); // never even reaches evaluateForDeletion
  });

  it('does not re-log an identical watch_dropped event on a retry, but still retries the drop itself', async () => {
    // Still 'added' -- a prior sync's drop attempt didn't stick (e.g. a foreign Radarr tag, a
    // stale radarrMovieId, or Radarr being briefly unreachable -- evaluateForDeletion logs its
    // own specific reason and returns without throwing in each case). The most recent MovieEvent
    // for this film is already this same list's watch_dropped -- that's not new information.
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: before, movie: { tmdbId: 100, state: 'added' } },
    ]);
    mockPrisma.movieEvent.findFirst.mockResolvedValue({ type: 'watch_dropped', listId: 10 });
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie()); // still 'added' -- e.g. a foreign tag keeps blocking it
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [1, 99] });
    (getAllTags as jest.Mock).mockResolvedValue([
      { id: 1, label: 'chris' },
      { id: 99, label: 'seerr' }, // foreign tag -- evaluateForDeletion will no-op every time
    ]);

    await reconcileWatched(makeList(), new Map([[100, after]]));

    expect(mockPrisma.movieEvent.create).not.toHaveBeenCalled();
    expect(setMonitored).not.toHaveBeenCalled(); // evaluateForDeletion still ran and still declined
  });

  it('logs again if the most recent event is a different list\'s watch_dropped', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, firstSeenAt: before, movie: { tmdbId: 100, state: 'added' } },
    ]);
    mockPrisma.movieEvent.findFirst.mockResolvedValue({ type: 'watch_dropped', listId: 999 }); // a different list
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileWatched(makeList(), new Map([[100, after]]));

    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: {
        movieId: 1,
        type: 'watch_dropped',
        listId: 10,
        detail: 'owner watched this film; list "Chris\'s watchlist" (removeOnWatch) drops its claim',
      },
    });
  });
});

describe('approveDeletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    (deleteMovie as jest.Mock).mockResolvedValue(undefined);
    mockPrisma.deletionRequest.update.mockResolvedValue({});
  });

  function makeRequest(overrides: Partial<DeletionRequest> & { movie?: any } = {}) {
    return {
      id: 1,
      movieId: 1,
      reason: 'left_list',
      triggeredByListId: 10,
      status: 'pending',
      createdAt: now,
      resolvedAt: null,
      movie: makeMovie(),
      ...overrides,
    };
  }

  it('deletes from Radarr (always with files), resolves approved, and transitions to deleted', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue(makeRequest());

    await approveDeletion(1);

    expect(deleteMovie).toHaveBeenCalledWith(expect.anything(), 500);
    expect(mockPrisma.deletionRequest.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'approved', resolvedAt: expect.any(Date) },
    });
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'deleted' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'deleted', detail: 'file deleted' },
    });
  });

  it('throws if the request is not pending', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue(makeRequest({ status: 'approved' }));

    await expect(approveDeletion(1)).rejects.toThrow(/already approved/);
    expect(deleteMovie).not.toHaveBeenCalled();
  });

  it('throws if the request does not exist', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue(null);

    await expect(approveDeletion(1)).rejects.toThrow(/not found/);
  });
});

describe('keepDeletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.movie.update.mockResolvedValue({});
    mockPrisma.deletionRequest.update.mockResolvedValue({});
  });

  it('transitions the film to kept and resolves the request as kept', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue({ id: 1, movieId: 1, status: 'pending' });

    await keepDeletion(1);

    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'kept' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({ data: { movieId: 1, type: 'kept' } });
    expect(mockPrisma.deletionRequest.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'kept', resolvedAt: expect.any(Date) },
    });
  });

  it('throws if the request is not pending', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue({ id: 1, movieId: 1, status: 'kept' });

    await expect(keepDeletion(1)).rejects.toThrow(/already kept/);
    expect(mockPrisma.movie.update).not.toHaveBeenCalled();
  });
});

describe('deleteList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([{ tag: 'chris' }]);
    mockPrisma.list.findMany.mockResolvedValue([{ extraTags: null }]);
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.list.delete.mockResolvedValue({});
    mockPrisma.movie.update.mockResolvedValue({});
    mockPrisma.listMovie.findFirst.mockResolvedValue(null);
    mockPrisma.deletionRequest.create.mockResolvedValue({});
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [] });
    (getAllTags as jest.Mock).mockResolvedValue([{ id: 1, label: 'chris' }]);
    (setMonitored as jest.Mock).mockResolvedValue(undefined);
  });

  it('throws when the list does not exist', async () => {
    mockPrisma.list.findUnique.mockResolvedValue(null);
    await expect(deleteList(99)).rejects.toThrow(/not found/);
    expect(mockPrisma.list.delete).not.toHaveBeenCalled();
  });

  it('permanence off: deletes the list and queues its films for review (list_deleted)', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 10, label: 'L', permanence: false });
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { state: 'added' } }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await deleteList(10);

    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'list_deleted', listId: 10, detail: 'list "L" was deleted' },
    });
    expect(mockPrisma.list.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'list_deleted', triggeredByListId: null, status: 'pending' },
    });
  });

  it('permanence on: deletes the list and pins (transitions to kept) its Filmstrip-managed films instead of queueing', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 10, label: 'L', permanence: true });
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, movie: { state: 'added' } },
      { movieId: 2, movie: { state: 'pre_existing' } }, // not ours -> not pinned
      { movieId: 3, movie: { state: 'kept' } }, // already pinned (e.g. by live permanence) -> not re-pinned
    ]);

    await deleteList(10);

    // list_deleted is logged for every member, regardless of branch or already-kept status.
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'list_deleted', listId: 10, detail: 'list "L" was deleted' },
    });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 2, type: 'list_deleted', listId: 10, detail: 'list "L" was deleted' },
    });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 3, type: 'list_deleted', listId: 10, detail: 'list "L" was deleted' },
    });

    expect(mockPrisma.list.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(mockPrisma.movie.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'kept' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'kept', detail: 'list "L" deleted with permanence on' },
    });
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(setMonitored).not.toHaveBeenCalled();
  });

  it('permanence off: still deletes the list even if evaluating a film throws', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 10, label: 'L', permanence: false });
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { state: 'added' } }]);
    mockPrisma.movie.findUnique.mockRejectedValue(new Error('db boom'));

    await expect(deleteList(10)).resolves.toBeUndefined();
    expect(mockPrisma.list.delete).toHaveBeenCalled();
  });

  it('deletes the mirrored Jellyfin collection when the list had makeCollection on', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({
      id: 10,
      label: 'L',
      permanence: false,
      makeCollection: true,
      jellyfinCollectionId: 'col-1',
    });
    mockPrisma.listMovie.findMany.mockResolvedValue([]);
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings({ jellyfinUrl: 'http://jf', jellyfinApiKey: 'key' }));

    await deleteList(10);

    expect(deleteCollection).toHaveBeenCalledWith(expect.anything(), 'col-1');
  });

  it('does not attempt to delete a collection when makeCollection was off', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 10, label: 'L', permanence: false, makeCollection: false });
    mockPrisma.listMovie.findMany.mockResolvedValue([]);

    await deleteList(10);

    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('does not attempt to delete a collection that was never created (no stored id)', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({
      id: 10,
      label: 'L',
      permanence: false,
      makeCollection: true,
      jellyfinCollectionId: null,
    });
    mockPrisma.listMovie.findMany.mockResolvedValue([]);

    await deleteList(10);

    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('still deletes the list if removing its Jellyfin collection fails', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({
      id: 10,
      label: 'L',
      permanence: false,
      makeCollection: true,
      jellyfinCollectionId: 'col-1',
    });
    mockPrisma.listMovie.findMany.mockResolvedValue([]);
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings({ jellyfinUrl: 'http://jf', jellyfinApiKey: 'key' }));
    (deleteCollection as jest.Mock).mockRejectedValue(new Error('jellyfin down'));

    await expect(deleteList(10)).resolves.toBeUndefined();
    expect(mockPrisma.list.delete).toHaveBeenCalled();
  });
});

describe('applyPermanenceClaims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.deletionRequest.updateMany.mockResolvedValue({});
  });

  it('no-ops when the list is not permanence', async () => {
    await applyPermanenceClaims(makeList({ permanence: false }));

    expect(mockPrisma.listMovie.findMany).not.toHaveBeenCalled();
  });

  it('pins a currently-claimed added film to kept', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { state: 'added' } }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'added' }));

    await applyPermanenceClaims(makeList({ permanence: true, label: 'Keepers' }));

    expect(mockPrisma.listMovie.findMany).toHaveBeenCalledWith({
      where: { presentOnList: true, excluded: false, listId: 10 },
      select: { movieId: true, movie: { select: { state: true } } },
    });
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'kept' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'kept', detail: 'list "Keepers" (permanence) currently claims this film', listId: 10 },
    });
    expect(mockPrisma.deletionRequest.updateMany).not.toHaveBeenCalled();
  });

  it('pins a currently-claimed deletion_queued film to kept and resolves its pending request', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { state: 'deletion_queued' } }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'deletion_queued' }));

    await applyPermanenceClaims(makeList({ permanence: true }));

    expect(mockPrisma.deletionRequest.updateMany).toHaveBeenCalledWith({
      where: { movieId: 1, status: 'pending' },
      data: { status: 'kept', resolvedAt: expect.any(Date) },
    });
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'kept' } });
  });

  it('leaves an already-kept claimed film alone', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { state: 'kept' } }]);

    await applyPermanenceClaims(makeList({ permanence: true }));

    expect(mockPrisma.movie.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.movie.update).not.toHaveBeenCalled();
  });

  it('does not pin if the state raced away between the query and the transaction', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { state: 'added' } }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'kept' })); // raced to kept already

    await applyPermanenceClaims(makeList({ permanence: true }));

    expect(mockPrisma.movie.update).not.toHaveBeenCalled();
  });

  it('does not throw when pinning one film fails; the rest still run', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, movie: { state: 'added' } },
      { movieId: 2, movie: { state: 'added' } },
    ]);
    mockPrisma.movie.findUnique
      .mockRejectedValueOnce(new Error('db boom'))
      .mockResolvedValueOnce(makeMovie({ id: 2, state: 'added' }));

    await expect(applyPermanenceClaims(makeList({ permanence: true }))).resolves.toBeUndefined();
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { state: 'kept' } });
  });
});

describe('handleListDisabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.listMovie.findFirst.mockResolvedValue(null);
    mockPrisma.deletionRequest.create.mockResolvedValue({});
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [] });
    (getAllTags as jest.Mock).mockResolvedValue([{ id: 1, label: 'chris' }]);
    (setMonitored as jest.Mock).mockResolvedValue(undefined);
  });

  it('no-ops when the list holds no claims', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([]);

    await handleListDisabled(makeList());

    expect(mockPrisma.movieEvent.create).not.toHaveBeenCalled();
  });

  it('logs list_deactivated for every claim, then evaluates each for deletion', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1 }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await handleListDisabled(makeList({ label: 'Old list' }));

    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: { movieId: 1, type: 'list_deactivated', listId: 10, detail: 'list "Old list" was disabled' },
    });
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'list_deactivated', triggeredByListId: 10, status: 'pending' },
    });
  });

  it('does not throw when evaluating one claim fails', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1 }]);
    mockPrisma.movie.findUnique.mockRejectedValue(new Error('db boom'));

    await expect(handleListDisabled(makeList())).resolves.toBeUndefined();
  });
});

describe('dropKeepStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.listMovie.findFirst.mockResolvedValue(null); // hasClaim: no claims, by default
    mockPrisma.deletionRequest.create.mockResolvedValue({});
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [] });
    (setMonitored as jest.Mock).mockResolvedValue(undefined);
  });

  it('releases a kept film with zero claims into deletion_queued', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'kept' }));

    await dropKeepStatus(1);

    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'deletion_queued' } });
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'manual_reopen', triggeredByListId: null, status: 'pending' },
    });
  });

  it('throws if the film is not kept', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'added' }));

    await expect(dropKeepStatus(1)).rejects.toThrow(/is not kept/);
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('throws if any enabled list still claims the film', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'kept' }));
    mockPrisma.listMovie.findFirst.mockResolvedValue({ id: 2 });

    await expect(dropKeepStatus(1)).rejects.toThrow(/still claimed/);
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('throws if the movie does not exist', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue(null);

    await expect(dropKeepStatus(1)).rejects.toThrow(/not found/);
  });
});

describe('getSoleOwnerUserId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the single user when every ListMovie row belongs to that user\'s lists', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ list: { userId: 1 } }, { list: { userId: 1 } }]);

    await expect(getSoleOwnerUserId(1)).resolves.toBe(1);
  });

  it('returns null when the film has been added by more than one user\'s lists', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ list: { userId: 1 } }, { list: { userId: 2 } }]);

    await expect(getSoleOwnerUserId(1)).resolves.toBeNull();
  });

  it('returns null when there are no ListMovie rows at all (e.g. the sole list was deleted)', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([]);

    await expect(getSoleOwnerUserId(1)).resolves.toBeNull();
  });
});

describe('convertToManaged', () => {
  const before = new Date('2025-06-01T00:00:00Z');
  const after = new Date('2026-06-01T00:00:00Z');

  /** Feed successive calls to movie.findUnique a fixed sequence of states (the last one repeats
   *  for any call beyond the list) -- convertToManaged/evaluateForDeletion/reconcileWatched each
   *  re-read the movie at different points, so a single static mock can't distinguish them. */
  function mockMovieStates(...states: string[]) {
    let i = 0;
    mockPrisma.movie.findUnique.mockImplementation(() =>
      Promise.resolve(makeMovie({ state: states[Math.min(i++, states.length - 1)] }))
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.user.findMany.mockResolvedValue([{ tag: 'chris' }]); // getKnownTagLabels, via evaluateForDeletion
    mockPrisma.list.findMany.mockResolvedValue([{ extraTags: null }]);
    mockPrisma.listMovie.findFirst.mockResolvedValue(null); // hasClaim/hasOrdinaryClaim: none, by default
    mockPrisma.listMovie.findMany.mockResolvedValue([]); // no removeOnWatch claiming lists, by default
    mockPrisma.deletionRequest.create.mockResolvedValue({});
    mockPrisma.movieEvent.findFirst.mockResolvedValue(null); // no prior watch_dropped event, by default
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [] });
    (getAllTags as jest.Mock).mockResolvedValue([{ id: 1, label: 'chris' }]);
    (setMonitored as jest.Mock).mockResolvedValue(undefined);
    (getDiaryWatchedDates as jest.Mock).mockResolvedValue(new Map());
  });

  it('throws if the movie does not exist', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue(null);

    await expect(convertToManaged(1)).rejects.toThrow(/not found/);
  });

  it('throws if the movie is not pre_existing', async () => {
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ state: 'added' }));

    await expect(convertToManaged(1)).rejects.toThrow(/not pre_existing/);
    expect(mockPrisma.movie.update).not.toHaveBeenCalled();
  });

  it('transitions the film to added and logs converted_to_managed', async () => {
    mockMovieStates('pre_existing', 'added'); // initial load, then the final re-fetch for the result
    mockPrisma.listMovie.findFirst.mockResolvedValue({ id: 2 }); // hasClaim: an ordinary claim exists

    const result = await convertToManaged(1);

    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { state: 'added' } });
    expect(mockPrisma.movieEvent.create).toHaveBeenCalledWith({
      data: {
        movieId: 1,
        type: 'converted_to_managed',
        detail: 'Manually converted from pre_existing by an admin',
      },
    });
    expect(result).toEqual({ queued: false });
  });

  it('needs no special handling for an existing unwatchedOnly claim -- it already counts via hasClaim', async () => {
    mockMovieStates('pre_existing', 'added');
    mockPrisma.listMovie.findFirst.mockResolvedValue({ id: 2 }); // hasClaim: true (the unwatchedOnly list's row)
    mockPrisma.listMovie.findMany.mockResolvedValue([]); // no removeOnWatch lists claiming it

    const result = await convertToManaged(1);

    expect(getDiaryWatchedDates).not.toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(result).toEqual({ queued: false });
  });

  it('immediately queues for deletion (reason left_list) when the film has zero current claims', async () => {
    mockMovieStates('pre_existing', 'added', 'added', 'deletion_queued');
    // listMovie.findFirst defaults to null (beforeEach) -- hasClaim is false.

    const result = await convertToManaged(1);

    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'left_list', triggeredByListId: null, status: 'pending' },
    });
    expect(result).toEqual({ queued: true });
  });

  it('immediately queues for deletion (reason watched) when a claiming removeOnWatch list already has a stale diary watch', async () => {
    mockMovieStates('pre_existing', 'added', 'added', 'deletion_queued');
    // hasClaim: true (first call only) -- hasOrdinaryClaim, checked later inside reconcileWatched,
    // falls back to the null default so the date check below actually runs.
    mockPrisma.listMovie.findFirst.mockResolvedValueOnce({ id: 2 });
    mockPrisma.listMovie.findMany
      .mockResolvedValueOnce([{ list: makeList({ removeOnWatch: true }) }]) // convertToManaged's own query
      .mockResolvedValueOnce([{ movieId: 1, firstSeenAt: before, movie: { tmdbId: 100, state: 'added' } }]); // reconcileWatched's own query
    (getDiaryWatchedDates as jest.Mock).mockResolvedValue(new Map([[100, after]]));

    const result = await convertToManaged(1);

    expect(getDiaryWatchedDates).toHaveBeenCalledWith(1);
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'watched', triggeredByListId: 10, status: 'pending' },
    });
    expect(result).toEqual({ queued: true });
  });

  it('does not queue when a claiming removeOnWatch list has no diary watch postdating its claim', async () => {
    mockMovieStates('pre_existing', 'added');
    mockPrisma.listMovie.findFirst.mockResolvedValueOnce({ id: 2 }); // hasClaim: true; hasOrdinaryClaim falls back to null
    mockPrisma.listMovie.findMany
      .mockResolvedValueOnce([{ list: makeList({ removeOnWatch: true }) }])
      .mockResolvedValueOnce([{ movieId: 1, firstSeenAt: after, movie: { tmdbId: 100, state: 'added' } }]);
    (getDiaryWatchedDates as jest.Mock).mockResolvedValue(new Map([[100, before]])); // watch predates the claim

    const result = await convertToManaged(1);

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(result).toEqual({ queued: false });
  });
});
