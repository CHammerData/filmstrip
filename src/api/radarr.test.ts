// Mock axios before importing radarr
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock('axios', () => {
  return {
    create: jest.fn(() => mockAxiosInstance),
    default: {
      create: jest.fn(() => mockAxiosInstance),
    },
  };
});

// Mock logger
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Import after mocking
import {
  createRadarrClient,
  getQualityProfileId,
  getRootFolder,
  getRootFolderById,
  getOrCreateTag,
  getAllRequiredTagIds,
  addMovie,
  upsertMovies,
  getMovieById,
  getAllTags,
  setMonitored,
  deleteMovie,
  RadarrUpsertOptions,
} from './radarr';

// The client the helpers receive. createRadarrClient returns the mocked axios
// instance, so this is just the mock under a meaningful name.
const client = createRadarrClient({ url: 'http://localhost:7878', apiKey: 'test-key' });

const baseOptions: RadarrUpsertOptions = {
  qualityProfile: 'HD-1080p',
  minimumAvailability: 'released',
  monitored: true,
  tags: ['letterboxd'],
  dryRun: false,
};

describe('radarr API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createRadarrClient', () => {
    it('returns an axios instance', () => {
      expect(client).toBe(mockAxiosInstance);
    });
  });

  describe('getQualityProfileId', () => {
    it('should return quality profile ID when profile exists', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'SD' },
          { id: 2, name: 'HD-1080p' },
          { id: 3, name: '4K' },
        ],
      });

      const result = await getQualityProfileId(client, 'HD-1080p');

      expect(result).toBe(2);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/qualityprofile');
    });

    it('should return null when profile does not exist', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'SD' },
          { id: 2, name: 'HD-1080p' },
        ],
      });

      const result = await getQualityProfileId(client, 'NonExistent');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await getQualityProfileId(client, 'HD-1080p');

      expect(result).toBeNull();
    });
  });

  describe('getRootFolder', () => {
    it('should return first root folder path', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, path: '/movies' },
          { id: 2, path: '/movies2' },
        ],
      });

      const result = await getRootFolder(client);

      expect(result).toBe('/movies');
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/rootfolder');
    });

    it('should return null when no root folders exist', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [],
      });

      const result = await getRootFolder(client);

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await getRootFolder(client);

      expect(result).toBeNull();
    });
  });

  describe('getRootFolderById', () => {
    it('should return root folder path by ID', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { id: 1, path: '/movies' },
      });

      const result = await getRootFolderById(client, '1');

      expect(result).toBe('/movies');
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/rootfolder/1');
    });

    it('should return null when folder not found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: null,
      });

      const result = await getRootFolderById(client, '999');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await getRootFolderById(client, '1');

      expect(result).toBeNull();
    });
  });

  describe('getOrCreateTag', () => {
    it('should return existing tag ID', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 1, label: 'letterboxd' },
          { id: 2, label: 'other' },
        ],
      });

      const result = await getOrCreateTag(client, 'letterboxd');

      expect(result).toBe(1);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/tag');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should create new tag when it does not exist', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, label: 'existing' }],
      });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 2, label: 'newtag' },
      });

      const result = await getOrCreateTag(client, 'newtag');

      expect(result).toBe(2);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/tag', {
        label: 'newtag',
      });
    });

    it('should return null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await getOrCreateTag(client, 'testtag');

      expect(result).toBeNull();
    });
  });

  describe('getAllRequiredTagIds', () => {
    it('should return tag IDs for all configured tags', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: [],
      });

      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 1, label: 'letterboxd' } })
        .mockResolvedValueOnce({ data: { id: 2, label: 'tag1' } })
        .mockResolvedValueOnce({ data: { id: 3, label: 'tag2' } });

      const result = await getAllRequiredTagIds(client, ['letterboxd', 'tag1', 'tag2']);

      expect(result).toHaveLength(3);
      expect(result).toContain(1);
      expect(result).toContain(2);
      expect(result).toContain(3);
    });

    it('should filter out null tag IDs', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: [],
      });

      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 1, label: 'letterboxd' } })
        .mockRejectedValueOnce(new Error('Failed to create tag'))
        .mockResolvedValueOnce({ data: { id: 3, label: 'tag2' } });

      const result = await getAllRequiredTagIds(client, ['letterboxd', 'tag1', 'tag2']);

      expect(result).toHaveLength(2);
      expect(result).toContain(1);
      expect(result).toContain(3);
    });

    it('should dedup and ignore blank tag names', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: [] });
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 1, label: 'letterboxd' } });

      const result = await getAllRequiredTagIds(client, ['letterboxd', 'letterboxd', '  ', '']);

      expect(result).toEqual([1]);
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('addMovie', () => {
    const mockMovie = {
      id: 1,
      name: 'Test Movie',
      slug: '/film/test-movie/',
      tmdbId: '12345',
      imdbId: 'tt12345',
      publishedYear: 2020,
    };

    const addParams = {
      qualityProfileId: 2,
      rootFolderPath: '/movies',
      tagIds: [1, 2],
      minimumAvailability: 'released',
      monitored: true,
      dryRun: false,
    };

    it('should add movie to Radarr successfully', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { id: 99, title: 'Test Movie' },
      });

      const result = await addMovie(client, mockMovie, addParams);

      expect(result).toMatchObject({ status: 'added', radarrMovieId: 99 });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/movie', {
        title: 'Test Movie',
        qualityProfileId: 2,
        rootFolderPath: '/movies',
        tmdbId: 12345,
        minimumAvailability: 'released',
        monitored: true,
        tags: [1, 2],
        addOptions: {
          searchForMovie: true,
        },
      });
    });

    it('should skip movie without tmdbId', async () => {
      const movieWithoutTmdb = {
        ...mockMovie,
        tmdbId: null,
      };

      const result = await addMovie(client, movieWithoutTmdb, addParams);

      expect(result).toMatchObject({ status: 'skipped' });
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should not call Radarr in dry-run mode', async () => {
      const result = await addMovie(client, mockMovie, { ...addParams, dryRun: true });

      expect(result).toMatchObject({ status: 'dryRun' });
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should respect monitored=false', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 1 } });

      await addMovie(client, mockMovie, { ...addParams, monitored: false });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ monitored: false })
      );
    });

    it('should treat already-added as skipped', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: 'This movie has already been added',
        },
      });

      const result = await addMovie(client, mockMovie, addParams);

      expect(result).toMatchObject({ status: 'skipped' });
    });

    it('should report failed for other errors', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network error'));

      const result = await addMovie(client, mockMovie, addParams);

      expect(result).toMatchObject({ status: 'failed' });
    });
  });

  describe('upsertMovies', () => {
    const mockMovies = [
      {
        id: 1,
        name: 'Movie 1',
        slug: '/film/movie1/',
        tmdbId: '123',
        imdbId: null,
        publishedYear: null,
      },
      {
        id: 2,
        name: 'Movie 2',
        slug: '/film/movie2/',
        tmdbId: '456',
        imdbId: null,
        publishedYear: null,
      },
    ];

    it('should process all movies and summarise outcomes', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: [{ id: 2, name: 'HD-1080p' }],
        })
        .mockResolvedValueOnce({
          data: [{ id: 1, path: '/movies' }],
        })
        .mockResolvedValue({
          data: [],
        });

      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 1, label: 'letterboxd' } })
        .mockResolvedValueOnce({ data: { id: 10, title: 'Movie 1' } })
        .mockResolvedValueOnce({ data: { id: 11, title: 'Movie 2' } });

      const summary = await upsertMovies(client, mockMovies, baseOptions);

      expect(summary.added).toBe(2);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(0);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 1' })
      );
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/movie',
        expect.objectContaining({ title: 'Movie 2' })
      );
    });

    it('should throw error when quality profile not found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [],
      });

      await expect(upsertMovies(client, mockMovies, baseOptions)).rejects.toThrow(
        'Could not get quality profile ID.'
      );
    });

    it('should throw error when root folder not found', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: [{ id: 2, name: 'HD-1080p' }],
        })
        .mockResolvedValueOnce({
          data: [],
        });

      await expect(upsertMovies(client, mockMovies, baseOptions)).rejects.toThrow(
        'Could not get root folder'
      );
    });
  });

  describe('getMovieById', () => {
    it('returns the movie resource', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { id: 500, title: 'A Movie', tags: [1] } });

      const result = await getMovieById(client, 500);

      expect(result).toMatchObject({ id: 500, title: 'A Movie' });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/movie/500');
    });

    it('returns null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await getMovieById(client, 500);

      expect(result).toBeNull();
    });
  });

  describe('getAllTags', () => {
    it('returns the tag list', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [{ id: 1, label: 'letterboxd' }] });

      const result = await getAllTags(client);

      expect(result).toEqual([{ id: 1, label: 'letterboxd' }]);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/tag');
    });
  });

  describe('setMonitored', () => {
    it('PUTs the full movie resource with monitored overridden', async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });
      const movie = { id: 500, title: 'A Movie', tmdbId: 1, monitored: true, tags: [] };

      await setMonitored(client, movie, false);

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/api/v3/movie/500', {
        ...movie,
        monitored: false,
      });
    });
  });

  describe('deleteMovie', () => {
    it('DELETEs with the deleteFiles flag', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({ data: {} });

      await deleteMovie(client, 500, true);

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/api/v3/movie/500', {
        params: { deleteFiles: true, addImportExclusion: false },
      });
    });
  });
});
