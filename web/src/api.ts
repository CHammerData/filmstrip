// Thin fetch wrapper around the Filmstrip REST API. Cookies (the session) ride along via
// credentials: 'include'; errors surface as ApiError with the server's message + status.

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = (path: string) => api<void>(path, { method: 'DELETE' });

// ---- Domain types (mirror prisma/schema.prisma; only the fields the UI reads) ----

export interface User {
  id: number;
  name: string;
  tag: string;
  enabled: boolean;
  letterboxdUsername: string | null;
  jellyfinUserId: string | null;
}

export interface List {
  id: number;
  userId: number;
  url: string;
  listType: string;
  label: string;
  enabled: boolean;
  qualityProfile: string | null;
  rootFolderId: string | null;
  minimumAvailability: string | null;
  monitored: boolean;
  extraTags: string | null;
  takeAmount: number | null;
  takeStrategy: string | null;
  checkIntervalMin: number | null;
  deleteFiles: boolean;
  permanence: boolean;
  unwatchedOnly: boolean;
  removeOnWatch: boolean;
  makeCollection: boolean;
  collectionNameOverride: string | null;
  lastSyncedAt: string | null;
  user?: User;
}

// A Jellyfin account offered in the "add a user" picker. `linked` = a Filmstrip user already
// owns this Jellyfin id. `configured` is false when Jellyfin is unset/unreachable.
export interface JellyfinCandidate {
  id: string;
  name: string;
  isAdmin: boolean;
  linked: boolean;
}
export interface JellyfinCandidates {
  configured: boolean;
  // false = configured but Jellyfin couldn't be reached; the picker must not fall back to free-text.
  reachable: boolean;
  users: JellyfinCandidate[];
}

export interface Settings {
  id: number;
  radarrUrl: string | null;
  radarrApiKey: string | null;
  jellyfinUrl: string | null;
  jellyfinApiKey: string | null;
  defaultQualityProfile: string | null;
  defaultMinimumAvailability: string;
  defaultCheckIntervalMin: number;
  dryRun: boolean;
}

export interface Movie {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
}

// Radarr metadata for the list-settings dropdowns. `configured` is false when Radarr is
// unset/unreachable — the forms then fall back to free-text inputs.
export interface RadarrOptions {
  configured: boolean;
  qualityProfiles: { id: number; name: string }[];
  rootFolders: { id: number; path: string }[];
  tags: { id: number; label: string }[];
}

export type RadarrStatus = 'downloaded' | 'wanted' | 'unmonitored' | 'not_in_radarr' | 'unknown';

export interface MovieSource {
  listId: number;
  listLabel: string;
  listType: string;
  ownerName: string;
}

export type MovieState = 'wanted' | 'pre_existing' | 'added' | 'deletion_queued' | 'deleted' | 'kept';

export interface MovieRow {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
  state: MovieState;
  radarrStatus: RadarrStatus;
  radarr: { present: boolean; hasFile: boolean; monitored: boolean; sizeOnDisk: number } | null;
  sources: MovieSource[];
}

export type MovieEventType =
  | 'seen_on_list'
  | 'left_list'
  | 'restored_to_list'
  | 'radarr_add_failed'
  | 'added_to_radarr'
  | 'already_in_radarr'
  | 'deletion_queued'
  | 'deletion_queue_cancelled'
  | 'deleted'
  | 'kept'
  | 'revived'
  | 'backfilled';

export interface MovieHistoryEvent {
  id: number;
  type: MovieEventType;
  detail: string | null;
  listLabel: string | null;
  createdAt: string;
}

export interface MovieHistory {
  movie: { id: number; tmdbId: number; title: string; year: number | null; state: MovieState };
  events: MovieHistoryEvent[];
}

export interface DeletionRequest {
  id: number;
  reason: string;
  status: string;
  createdAt: string;
  movie: Movie;
  triggeredByList: List | null;
}

export interface SyncRun {
  id: number;
  listId: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  moviesFound: number;
  moviesAdded: number;
  moviesSkipped: number;
  moviesFailed: number;
  dryRun: boolean;
  error: string | null;
}

export interface SyncResult {
  listId: number;
  status: string;
  found: number;
  added: number;
  skipped: number;
  failed: number;
  error?: string;
  dryRun: boolean;
}

export interface Me {
  user: User;
  isAdmin: boolean;
}
