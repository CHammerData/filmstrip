import Axios, { AxiosInstance } from 'axios';
import logger from '../util/logger';

/** Connection to a single Jellyfin server, authenticated with a server API key. */
export interface JellyfinConnection {
  url: string;
  apiKey: string;
}

/** Build an axios client bound to one Jellyfin instance. */
export function createJellyfinClient(conn: JellyfinConnection): AxiosInstance {
  return Axios.create({
    baseURL: conn.url,
    headers: {
      'X-Emby-Token': conn.apiKey,
    },
  });
}

interface JellyfinItem {
  Id: string;
  Name: string;
  ProviderIds?: { Tmdb?: string };
}

/** Every movie the given user has marked played, as TMDB ids. */
export async function getWatchedTmdbIds(client: AxiosInstance, jellyfinUserId: string): Promise<Set<number>> {
  try {
    const response = await client.get(`/Users/${jellyfinUserId}/Items`, {
      params: {
        IncludeItemTypes: 'Movie',
        Filters: 'IsPlayed',
        Recursive: true,
        Fields: 'ProviderIds',
      },
    });
    const items: JellyfinItem[] = response.data?.Items ?? [];
    return new Set(
      items
        .map((i) => (i.ProviderIds?.Tmdb ? parseInt(i.ProviderIds.Tmdb) : null))
        .filter((id): id is number => id !== null)
    );
  } catch (error) {
    logger.error(`Error getting Jellyfin watched items for user ${jellyfinUserId}:`, error);
    return new Set();
  }
}

/** Every movie in the Jellyfin library, mapped to its TMDB id (null if unmatched). Used to
 *  resolve a film's Jellyfin item id for collection membership. */
export async function getAllMovieProviderIds(
  client: AxiosInstance
): Promise<{ id: string; tmdbId: number | null }[]> {
  try {
    const response = await client.get('/Items', {
      params: { IncludeItemTypes: 'Movie', Recursive: true, Fields: 'ProviderIds' },
    });
    const items: JellyfinItem[] = response.data?.Items ?? [];
    return items.map((i) => ({
      id: i.Id,
      tmdbId: i.ProviderIds?.Tmdb ? parseInt(i.ProviderIds.Tmdb) : null,
    }));
  } catch (error) {
    logger.error('Error listing Jellyfin movies:', error);
    return [];
  }
}

/** Find an existing collection (BoxSet) by exact name, or null. */
export async function findCollectionByName(client: AxiosInstance, name: string): Promise<{ id: string } | null> {
  try {
    const response = await client.get('/Items', {
      params: { IncludeItemTypes: 'BoxSet', Recursive: true, Fields: 'Name' },
    });
    const items: JellyfinItem[] = response.data?.Items ?? [];
    const match = items.find((i) => i.Name === name);
    return match ? { id: match.Id } : null;
  } catch (error) {
    logger.error(`Error finding Jellyfin collection "${name}":`, error);
    return null;
  }
}

/** Create a new collection with the given initial members. */
export async function createCollection(
  client: AxiosInstance,
  name: string,
  itemIds: string[]
): Promise<{ id: string }> {
  const response = await client.post('/Collections', null, {
    params: { Name: name, Ids: itemIds.join(',') },
  });
  return { id: response.data.Id };
}

/** Current member item ids of a collection. */
export async function getCollectionItemIds(client: AxiosInstance, collectionId: string): Promise<string[]> {
  try {
    const response = await client.get('/Items', { params: { ParentId: collectionId, Recursive: true } });
    const items: JellyfinItem[] = response.data?.Items ?? [];
    return items.map((i) => i.Id);
  } catch (error) {
    logger.error(`Error listing members of Jellyfin collection ${collectionId}:`, error);
    return [];
  }
}

export async function addToCollection(client: AxiosInstance, collectionId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await client.post(`/Collections/${collectionId}/Items`, null, { params: { Ids: itemIds.join(',') } });
}

export async function removeFromCollection(
  client: AxiosInstance,
  collectionId: string,
  itemIds: string[]
): Promise<void> {
  if (itemIds.length === 0) return;
  await client.delete(`/Collections/${collectionId}/Items`, { params: { Ids: itemIds.join(',') } });
}
