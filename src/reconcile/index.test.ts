import { Settings, List, User, Movie, DeletionRequest } from '@prisma/client';

const mockPrisma = {
  settings: { findUnique: jest.fn() },
  user: { findMany: jest.fn() },
  list: { findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
  movie: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  listMovie: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  deletionRequest: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
};

jest.mock('../db/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../api/radarr', () => ({
  __esModule: true,
  createRadarrClient: jest.fn(() => ({})),
  getMovieById: jest.fn(),
  getAllTags: jest.fn(),
  setMonitored: jest.fn(),
  deleteMovie: jest.fn(),
}));
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { reconcileList, reconcileWatched, deleteList, approveDeletion, keepDeletion } from './index';
import { getMovieById, getAllTags, setMonitored, deleteMovie } from '../api/radarr';
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

describe('reconcileList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([{ tag: 'chris' }]);
    mockPrisma.list.findMany.mockResolvedValue([{ extraTags: null }]);
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.listMovie.update.mockResolvedValue({});
    mockPrisma.listMovie.findFirst.mockResolvedValue(null); // nothing else wants it, by default
    mockPrisma.deletionRequest.findFirst.mockResolvedValue(null); // no existing pending request
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
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
    ]);

    await reconcileList(makeList(), new Set([100]));

    expect(mockPrisma.listMovie.update).not.toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('marks a dropped-off movie not present, and opens a DeletionRequest when eligible', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.listMovie.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { presentOnList: false, removedFromListAt: expect.any(Date) },
    });
    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'left_list', triggeredByListId: 10, status: 'pending' },
    });
  });

  it('does not open a DeletionRequest for a film not added by Filmstrip', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ addedByFilmstrip: false }));

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.listMovie.update).toHaveBeenCalled();
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not open a DeletionRequest for a pinned film', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ pinned: true }));

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not open a DeletionRequest when another enabled list still wants the film', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());
    mockPrisma.listMovie.findFirst.mockResolvedValue({ id: 2 }); // still present on some other list

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(setMonitored).not.toHaveBeenCalled();
  });

  it('never touches a film carrying a foreign Radarr tag', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
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

  it('skips a film that already has a pending DeletionRequest', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());
    mockPrisma.deletionRequest.findFirst.mockResolvedValue({ id: 5, status: 'pending' });

    await reconcileList(makeList(), new Set());

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not throw when evaluating one movie fails, and still updates presentOnList', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { id: 1, movieId: 1, movie: { tmdbId: 100 } },
    ]);
    mockPrisma.movie.findUnique.mockRejectedValue(new Error('db boom'));

    await expect(reconcileList(makeList(), new Set())).resolves.toBeUndefined();
    expect(mockPrisma.listMovie.update).toHaveBeenCalled();
  });
});

describe('reconcileWatched', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([{ tag: 'chris' }]);
    mockPrisma.list.findMany.mockResolvedValue([{ extraTags: null }]);
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    mockPrisma.deletionRequest.findFirst.mockResolvedValue(null);
    mockPrisma.deletionRequest.create.mockResolvedValue({});
    (getMovieById as jest.Mock).mockResolvedValue({ id: 500, title: 'A Movie', tags: [] });
    (getAllTags as jest.Mock).mockResolvedValue([{ id: 1, label: 'chris' }]);
    (setMonitored as jest.Mock).mockResolvedValue(undefined);
  });

  it('does nothing when nothing is watched', async () => {
    await reconcileWatched(makeList(), new Set());

    expect(mockPrisma.listMovie.findMany).not.toHaveBeenCalled();
  });

  it('queues a still-on-the-list film the owner has watched, without checking other lists', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { tmdbId: 100 } }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await reconcileWatched(makeList(), new Set([100]));

    // requireNotWanted is false for the watched path -- listMovie.findFirst (the
    // "still wanted elsewhere" check) is never consulted.
    expect(mockPrisma.listMovie.findFirst).not.toHaveBeenCalled();
    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'watched', triggeredByListId: 10, status: 'pending' },
    });
  });

  it('ignores films on the list that are not watched', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { tmdbId: 100 } }]);

    await reconcileWatched(makeList(), new Set([999]));

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('does not queue a pinned film', async () => {
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { tmdbId: 100 } }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie({ pinned: true }));

    await reconcileWatched(makeList(), new Set([100]));

    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
  });
});

describe('approveDeletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.settings.findUnique.mockResolvedValue(makeSettings());
    (deleteMovie as jest.Mock).mockResolvedValue(undefined);
    mockPrisma.deletionRequest.update.mockResolvedValue({});
  });

  function makeRequest(overrides: Partial<DeletionRequest> & { movie?: any; triggeredByList?: any } = {}) {
    return {
      id: 1,
      movieId: 1,
      reason: 'left_list',
      triggeredByListId: 10,
      status: 'pending',
      createdAt: now,
      resolvedAt: null,
      movie: makeMovie(),
      triggeredByList: makeList(),
      ...overrides,
    };
  }

  it('deletes from Radarr using the triggering list deleteFiles setting, and resolves approved', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue(
      makeRequest({ triggeredByList: makeList({ deleteFiles: false }) })
    );

    await approveDeletion(1);

    expect(deleteMovie).toHaveBeenCalledWith(expect.anything(), 500, false);
    expect(mockPrisma.deletionRequest.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'approved', resolvedAt: expect.any(Date) },
    });
  });

  it('defaults deleteFiles to true when there is no triggering list', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue(makeRequest({ triggeredByList: null }));

    await approveDeletion(1);

    expect(deleteMovie).toHaveBeenCalledWith(expect.anything(), 500, true);
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

  it('pins the film and resolves the request as kept', async () => {
    mockPrisma.deletionRequest.findUnique.mockResolvedValue({ id: 1, movieId: 1, status: 'pending' });

    await keepDeletion(1);

    expect(mockPrisma.movie.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { pinned: true } });
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
    mockPrisma.movie.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.listMovie.findFirst.mockResolvedValue(null);
    mockPrisma.deletionRequest.findFirst.mockResolvedValue(null);
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
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { addedByFilmstrip: true } }]);
    mockPrisma.movie.findUnique.mockResolvedValue(makeMovie());

    await deleteList(10);

    expect(mockPrisma.list.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(setMonitored).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 500 }), false);
    expect(mockPrisma.deletionRequest.create).toHaveBeenCalledWith({
      data: { movieId: 1, reason: 'list_deleted', triggeredByListId: null, status: 'pending' },
    });
    expect(mockPrisma.movie.updateMany).not.toHaveBeenCalled();
  });

  it('permanence on: deletes the list and pins its Filmstrip-added films instead of queueing', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 10, label: 'L', permanence: true });
    mockPrisma.listMovie.findMany.mockResolvedValue([
      { movieId: 1, movie: { addedByFilmstrip: true } },
      { movieId: 2, movie: { addedByFilmstrip: false } }, // not ours -> not pinned
    ]);

    await deleteList(10);

    expect(mockPrisma.list.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(mockPrisma.movie.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1] } }, data: { pinned: true } });
    expect(mockPrisma.deletionRequest.create).not.toHaveBeenCalled();
    expect(setMonitored).not.toHaveBeenCalled();
  });

  it('permanence off: still deletes the list even if evaluating a film throws', async () => {
    mockPrisma.list.findUnique.mockResolvedValue({ id: 10, label: 'L', permanence: false });
    mockPrisma.listMovie.findMany.mockResolvedValue([{ movieId: 1, movie: { addedByFilmstrip: true } }]);
    mockPrisma.movie.findUnique.mockRejectedValue(new Error('db boom'));

    await expect(deleteList(10)).resolves.toBeUndefined();
    expect(mockPrisma.list.delete).toHaveBeenCalled();
  });
});
