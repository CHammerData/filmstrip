import Axios, { AxiosInstance } from 'axios';
import logger from '../util/logger';
import { JellyfinAuthError } from './jellyfin.errors';

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

/** The identity Jellyfin returns for an authenticated user (subset we care about). */
export interface JellyfinIdentity {
  jellyfinUserId: string;
  name: string;
  isAdmin: boolean;
}

/**
 * Authenticate a username/password against Jellyfin (POST /Users/AuthenticateByName). Used by the
 * GUI login flow -- no server API key needed, just the connection URL. Returns the user's Jellyfin
 * id, display name, and admin flag; throws on bad credentials or an unreachable server.
 */
export async function authenticateByName(
  url: string,
  username: string,
  password: string
): Promise<JellyfinIdentity> {
  const client = Axios.create({
    baseURL: url,
    headers: {
      // Jellyfin requires this header on AuthenticateByName; the field values are arbitrary labels.
      'X-Emby-Authorization':
        'MediaBrowser Client="Filmstrip", Device="Filmstrip Server", DeviceId="filmstrip-server", Version="1.0.0"',
    },
  });

  let response;
  try {
    response = await client.post('/Users/AuthenticateByName', { Username: username, Pw: password });
  } catch (e) {
    // Turn a raw axios/URL failure into a classified error the login route can map to an honest
    // status (bad URL != wrong password != server down).
    throw classifyAuthError(e, url);
  }

  const user = response.data?.User;
  if (!user?.Id) {
    throw new JellyfinAuthError(
      'bad-response',
      'Jellyfin returned an unexpected response during authentication.',
      `url="${url}" reason="no User.Id in response"`
    );
  }
  return {
    jellyfinUserId: user.Id,
    name: user.Name,
    isAdmin: !!user.Policy?.IsAdministrator,
  };
}

/** Map a thrown fetch/axios error from AuthenticateByName to a classified JellyfinAuthError. */
function classifyAuthError(e: unknown, url: string): JellyfinAuthError {
  const err = e as { code?: string; message?: string; response?: { status?: number } };
  const msg = err?.message ?? String(e);

  // Malformed URL (e.g. schemeless "host.tld" or a bare "host:port") — thrown before any request.
  if (err?.code === 'ERR_INVALID_URL' || /invalid url/i.test(msg)) {
    return new JellyfinAuthError(
      'invalid-url',
      'The configured Jellyfin URL is invalid — it must include http:// or https://.',
      `url="${url}"`,
      e
    );
  }

  const status = err?.response?.status;
  if (status === 401) {
    return new JellyfinAuthError('bad-credentials', 'Invalid Jellyfin credentials.', `url="${url}"`, e);
  }
  if (typeof status === 'number') {
    return new JellyfinAuthError(
      'bad-response',
      'Jellyfin returned an unexpected response during authentication.',
      `url="${url}" http=${status}`,
      e
    );
  }

  // No HTTP response at all -> couldn't reach the server (DNS failure, connection refused, timeout).
  return new JellyfinAuthError(
    'unreachable',
    'Could not reach the Jellyfin server — check the Jellyfin URL in Settings.',
    `url="${url}" ${err?.code ?? msg}`,
    e
  );
}

/** A Jellyfin account, for the "pick a user to add" dropdown. */
export interface JellyfinUserSummary {
  id: string;
  name: string;
  isAdmin: boolean;
}

/** Every user account on the Jellyfin server (GET /Users, needs the server API key). */
export async function getUsers(client: AxiosInstance): Promise<JellyfinUserSummary[]> {
  const response = await client.get('/Users');
  return (response.data as any[]).map((u) => ({
    id: u.Id,
    name: u.Name,
    isAdmin: !!u.Policy?.IsAdministrator,
  }));
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
  } catch (error: any) {
    logger.error(`Error getting Jellyfin watched items for user ${jellyfinUserId}: ${error?.message ?? error}`);
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
  } catch (error: any) {
    logger.error(`Error listing Jellyfin movies: ${error?.message ?? error}`);
    return [];
  }
}

/** Find an existing collection (BoxSet) by exact name, or null. Only used to adopt a collection
 *  that predates `List.jellyfinCollectionId` tracking (or one an admin created by hand) -- once
 *  adopted, syncCollection looks it up by id instead (see `getCollectionById`), since the name
 *  itself can change. */
export async function findCollectionByName(client: AxiosInstance, name: string): Promise<{ id: string; name: string } | null> {
  try {
    const response = await client.get('/Items', {
      params: { IncludeItemTypes: 'BoxSet', Recursive: true, Fields: 'Name' },
    });
    const items: JellyfinItem[] = response.data?.Items ?? [];
    const match = items.find((i) => i.Name === name);
    return match ? { id: match.Id, name: match.Name } : null;
  } catch (error: any) {
    logger.error(`Error finding Jellyfin collection "${name}": ${error?.message ?? error}`);
    return null;
  }
}

/** Look up a collection (or any item) by its Jellyfin id. `GET /Items/{id}` isn't a valid route
 *  (confirmed against a real server -- 400, not 404), so this filters the same `/Items` list
 *  endpoint everything else here uses. A stored id that no longer resolves (the collection was
 *  deleted directly in Jellyfin) simply comes back with an empty `Items` array, same as any other
 *  fetch failure -- either way the caller's job is the same: stop trusting the stored id. */
export async function getCollectionById(client: AxiosInstance, collectionId: string): Promise<{ id: string; name: string } | null> {
  try {
    const response = await client.get('/Items', { params: { Ids: collectionId, Fields: 'Name' } });
    const items: JellyfinItem[] = response.data?.Items ?? [];
    const match = items.find((i) => i.Id === collectionId);
    return match ? { id: match.Id, name: match.Name } : null;
  } catch (error: any) {
    logger.error(`Error fetching Jellyfin collection ${collectionId}: ${error?.message ?? error}`);
    return null;
  }
}

/** Rename a collection in place. Jellyfin's item-update endpoint (`POST /Items/{itemId}`) replaces
 *  the item's full metadata payload, so this fetches the current metadata first (via the same
 *  `/Items` list endpoint `getCollectionById` uses -- `GET /Items/{id}` itself isn't a valid route)
 *  and posts it back with only Name changed -- a partial body would blank out everything else
 *  Jellyfin knows about the collection. */
export async function renameCollection(client: AxiosInstance, collectionId: string, name: string): Promise<void> {
  const response = await client.get('/Items', {
    params: { Ids: collectionId, Fields: 'Overview,Genres,Tags,ProviderIds,DateCreated' },
  });
  const current = (response.data?.Items ?? [])[0];
  if (!current) throw new Error(`Jellyfin collection ${collectionId} not found while renaming.`);
  await client.post(`/Items/${collectionId}`, { ...current, Name: name });
}

/** Permanently delete a collection (BoxSet) from Jellyfin. Only removes the collection itself --
 *  its member films are untouched. */
export async function deleteCollection(client: AxiosInstance, collectionId: string): Promise<void> {
  await client.delete(`/Items/${collectionId}`);
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
  } catch (error: any) {
    logger.error(`Error listing members of Jellyfin collection ${collectionId}: ${error?.message ?? error}`);
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
