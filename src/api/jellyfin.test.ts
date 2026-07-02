const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockAxiosInstance),
  default: { create: jest.fn(() => mockAxiosInstance) },
}));

jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import {
  createJellyfinClient,
  getWatchedTmdbIds,
  getAllMovieProviderIds,
  findCollectionByName,
  createCollection,
  getCollectionItemIds,
  addToCollection,
  removeFromCollection,
  authenticateByName,
} from './jellyfin';

const client = createJellyfinClient({ url: 'http://localhost:8096', apiKey: 'test-key' });

describe('jellyfin API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('authenticateByName', () => {
    it('returns the user identity on success', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { User: { Id: 'jf-1', Name: 'Chris', Policy: { IsAdministrator: true } }, AccessToken: 'tok' },
      });

      const identity = await authenticateByName('http://localhost:8096', 'chris', 'pw');

      expect(identity).toEqual({ jellyfinUserId: 'jf-1', name: 'Chris', isAdmin: true });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/Users/AuthenticateByName', {
        Username: 'chris',
        Pw: 'pw',
      });
    });

    it('defaults isAdmin to false when Policy is absent', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { User: { Id: 'jf-2', Name: 'Sam' } } });
      const identity = await authenticateByName('http://localhost:8096', 'sam', 'pw');
      expect(identity.isAdmin).toBe(false);
    });

    it('throws when no user comes back', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: {} });
      await expect(authenticateByName('http://localhost:8096', 'x', 'y')).rejects.toThrow(/no user/i);
    });

    it('propagates an auth failure', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Request failed with status code 401'));
      await expect(authenticateByName('http://localhost:8096', 'x', 'bad')).rejects.toThrow();
    });
  });

  describe('getWatchedTmdbIds', () => {
    it('returns the TMDB ids of played movies', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          Items: [
            { Id: 'a', Name: 'A', ProviderIds: { Tmdb: '100' } },
            { Id: 'b', Name: 'B', ProviderIds: {} },
          ],
        },
      });

      const result = await getWatchedTmdbIds(client, 'user-1');

      expect(result).toEqual(new Set([100]));
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/Users/user-1/Items',
        expect.objectContaining({ params: expect.objectContaining({ Filters: 'IsPlayed' }) })
      );
    });

    it('returns an empty set on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('network error'));

      const result = await getWatchedTmdbIds(client, 'user-1');

      expect(result).toEqual(new Set());
    });
  });

  describe('getAllMovieProviderIds', () => {
    it('maps items to their TMDB id, null when unmatched', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          Items: [
            { Id: 'a', Name: 'A', ProviderIds: { Tmdb: '100' } },
            { Id: 'b', Name: 'B' },
          ],
        },
      });

      const result = await getAllMovieProviderIds(client);

      expect(result).toEqual([
        { id: 'a', tmdbId: 100 },
        { id: 'b', tmdbId: null },
      ]);
    });

    it('returns an empty array on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('network error'));

      const result = await getAllMovieProviderIds(client);

      expect(result).toEqual([]);
    });
  });

  describe('findCollectionByName', () => {
    it('returns the matching collection id', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { Items: [{ Id: 'col-1', Name: 'Horror Picks' }] },
      });

      const result = await findCollectionByName(client, 'Horror Picks');

      expect(result).toEqual({ id: 'col-1' });
    });

    it('returns null when no exact match exists', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { Items: [{ Id: 'col-1', Name: 'Other' }] } });

      const result = await findCollectionByName(client, 'Horror Picks');

      expect(result).toBeNull();
    });

    it('returns null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('network error'));

      const result = await findCollectionByName(client, 'Horror Picks');

      expect(result).toBeNull();
    });
  });

  describe('createCollection', () => {
    it('POSTs the name and item ids', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { Id: 'col-1' } });

      const result = await createCollection(client, 'Horror Picks', ['a', 'b']);

      expect(result).toEqual({ id: 'col-1' });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/Collections', null, {
        params: { Name: 'Horror Picks', Ids: 'a,b' },
      });
    });
  });

  describe('getCollectionItemIds', () => {
    it('returns member item ids', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { Items: [{ Id: 'a' }, { Id: 'b' }] } });

      const result = await getCollectionItemIds(client, 'col-1');

      expect(result).toEqual(['a', 'b']);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/Items', { params: { ParentId: 'col-1', Recursive: true } });
    });

    it('returns an empty array on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('network error'));

      const result = await getCollectionItemIds(client, 'col-1');

      expect(result).toEqual([]);
    });
  });

  describe('addToCollection / removeFromCollection', () => {
    it('POSTs ids to add', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});

      await addToCollection(client, 'col-1', ['a', 'b']);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/Collections/col-1/Items', null, {
        params: { Ids: 'a,b' },
      });
    });

    it('no-ops when there is nothing to add', async () => {
      await addToCollection(client, 'col-1', []);

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('DELETEs ids to remove', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});

      await removeFromCollection(client, 'col-1', ['a']);

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/Collections/col-1/Items', {
        params: { Ids: 'a' },
      });
    });

    it('no-ops when there is nothing to remove', async () => {
      await removeFromCollection(client, 'col-1', []);

      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
    });
  });
});
