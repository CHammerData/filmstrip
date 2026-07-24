import Axios, { AxiosInstance } from 'axios';
import logger from '../util/logger';
import { LetterboxdMovie } from '../scraper';
import Bluebird from 'bluebird';

interface RadarrMovie {
    title: string;
    qualityProfileId: number;
    rootFolderPath: string;
    tmdbId: number;
    minimumAvailability: string;
    monitored: boolean;
    tags: number[];
    addOptions: {
        searchForMovie: boolean;
    }
}

/** Connection to a single Radarr instance. */
export interface RadarrConnection {
    url: string;
    apiKey: string;
}

/** Per-list options for an upsert run (resolved from List overrides + Settings). */
export interface RadarrUpsertOptions {
    qualityProfile: string;
    /** Radarr root folder id; when omitted the first configured root folder is used. */
    rootFolderId?: string;
    minimumAvailability: string;
    monitored: boolean;
    /** Full tag names to apply (already includes the user tag + "letterboxd"). */
    tags: string[];
    dryRun: boolean;
}

/** Outcome of attempting to add a single movie. */
export type AddStatus = 'added' | 'skipped' | 'failed' | 'dryRun';

export interface AddResult {
    movie: LetterboxdMovie;
    status: AddStatus;
    radarrMovieId?: number;
    reason?: string;
}

export interface UpsertSummary {
    added: number;
    skipped: number;
    failed: number;
    results: AddResult[];
}

/** Build an axios client bound to one Radarr instance. */
export function createRadarrClient(conn: RadarrConnection): AxiosInstance {
    return Axios.create({
        baseURL: conn.url,
        headers: {
            'X-Api-Key': conn.apiKey
        }
    });
}

export async function getQualityProfileId(client: AxiosInstance, profileName: string): Promise<number | null> {
    logger.debug(`Getting quality profile ID for: ${profileName}`);

    // A failed *request* (unreachable/wrong URL, bad API key, a proxy returning HTML) is a
    // connection problem — throw a clear error rather than returning null, which the caller would
    // otherwise report as the misleading "quality profile not found". Only a successful response
    // that simply lacks the named profile is a genuine null (config) result.
    let profiles: unknown;
    try {
        const response = await client.get('/api/v3/qualityprofile');
        profiles = response.data;
    } catch (error) {
        throw radarrRequestError('fetch quality profiles from Radarr', error, client);
    }

    if (!Array.isArray(profiles)) {
        throw new Error(
            'Radarr returned an unexpected response for quality profiles — check the Radarr URL and API key.'
        );
    }

    const profile = profiles.find((p: any) => p.name === profileName);
    if (profile) {
        logger.debug(`Found quality profile: ${profileName} (ID: ${profile.id})`);
        return profile.id;
    }

    logger.warn(
        `Quality profile "${profileName}" not found in Radarr. Available: ${profiles.map((p: any) => p.name).join(', ') || '(none)'}`
    );
    return null;
}

/** Turn a failed Radarr request into a clear, cause-bearing Error for the sync log. */
function radarrRequestError(action: string, error: unknown, client: AxiosInstance): Error {
    const err = error as { code?: string; message?: string; response?: { status?: number } };
    const baseURL = (client as { defaults?: { baseURL?: string } })?.defaults?.baseURL;
    const at = baseURL ? ` at ${baseURL}` : '';
    if (err?.response?.status) {
        return new Error(`Could not ${action}: Radarr${at} returned HTTP ${err.response.status} (check the URL and API key).`);
    }
    return new Error(`Could not ${action}: cannot reach Radarr${at} (${err?.code ?? err?.message ?? 'unknown error'}).`);
}

/** All quality profiles in Radarr (id + name), for populating the list-settings dropdowns. */
export async function getQualityProfiles(client: AxiosInstance): Promise<{ id: number; name: string }[]> {
    const response = await client.get('/api/v3/qualityprofile');
    return (response.data as any[]).map((p) => ({ id: p.id, name: p.name }));
}

/** All root folders in Radarr (id + path), for populating the list-settings dropdowns. */
export async function getRootFolders(client: AxiosInstance): Promise<{ id: number; path: string }[]> {
    const response = await client.get('/api/v3/rootfolder');
    return (response.data as any[]).map((f) => ({ id: f.id, path: f.path }));
}

export async function getRootFolder(client: AxiosInstance): Promise<string | null> {
    try {
        const response = await client.get('/api/v3/rootfolder');
        const rootFolders = response.data;

        if (rootFolders.length > 0) {
            const rootFolder = rootFolders[0].path;
            logger.debug(`Using root folder: ${rootFolder}`);
            return rootFolder;
        } else {
            logger.error('No root folders found in Radarr');
            return null;
        }
    } catch (error: any) {
        logger.error(`Error getting root folders: ${error?.message ?? error}`);
        return null;
    }
}

/** A Radarr movie resource as returned by /api/v3/movie/{id} (passthrough fields included). */
export interface RadarrMovieResource {
    id: number;
    title: string;
    tmdbId: number;
    monitored: boolean;
    tags: number[];
    [key: string]: any;
}

/** Every movie in Radarr, in one call. Used to enrich the Movies view with live status. Throws on
 *  error (e.g. Radarr unreachable) so the caller can tell "no movies" apart from "couldn't reach
 *  Radarr" and degrade to an "unknown" status rather than mislabel everything as not-in-Radarr. */
export async function getAllMovies(client: AxiosInstance): Promise<RadarrMovieResource[]> {
    const response = await client.get('/api/v3/movie');
    return response.data;
}

export async function getMovieById(client: AxiosInstance, id: number): Promise<RadarrMovieResource | null> {
    try {
        const response = await client.get(`/api/v3/movie/${id}`);
        return response.data;
    } catch (error: any) {
        logger.error(`Error getting Radarr movie id=${id}: ${error?.message ?? error}`);
        return null;
    }
}

export async function getAllTags(client: AxiosInstance): Promise<{ id: number; label: string }[]> {
    const response = await client.get('/api/v3/tag');
    return response.data;
}

/** Unmonitor (or re-monitor) a movie. Radarr's PUT replaces the whole resource, so the full
 *  object from getMovieById must be passed in. */
export async function setMonitored(
    client: AxiosInstance,
    movie: RadarrMovieResource,
    monitored: boolean
): Promise<void> {
    await client.put(`/api/v3/movie/${movie.id}`, { ...movie, monitored });
}

/** Deletes a movie from Radarr, always deleting its file too -- standard behavior, not a per-list
 *  toggle. */
export async function deleteMovie(client: AxiosInstance, id: number): Promise<void> {
    await client.delete(`/api/v3/movie/${id}`, { params: { deleteFiles: true, addImportExclusion: false } });
}

export async function getRootFolderById(client: AxiosInstance, id: string) {
    try {
        const response = await client.get(`/api/v3/rootfolder/${id}`);
        const { data } = response;
        if (data) {
            return data.path;
        } else {
            return null;
        }
    } catch (e) {
        logger.error(`Error getting root folder by id: ${id}`);
        return null;
    }
}

export async function getOrCreateTag(client: AxiosInstance, tagName: string): Promise<number | null> {
    try {
        logger.debug(`Getting or creating tag: ${tagName}`);

        const response = await client.get('/api/v3/tag');
        const tags = response.data;

        const existingTag = tags.find((tag: any) => tag.label === tagName);
        if (existingTag) {
            logger.debug(`Tag already exists: ${tagName} (ID: ${existingTag.id})`);
            return existingTag.id;
        }

        logger.debug(`Creating new tag: ${tagName}`);
        const createResponse = await client.post('/api/v3/tag', {
            label: tagName
        });

        logger.info(`Created tag: ${tagName} (ID: ${createResponse.data.id})`);
        return createResponse.data.id;
    } catch (error: any) {
        logger.error(`Error getting or creating tag ${tagName}: ${error?.message ?? error}`);
        return null;
    }
}

export async function getAllRequiredTagIds(client: AxiosInstance, tagNames: string[]): Promise<number[]> {
    const uniqueNames = [...new Set(tagNames.map(t => t.trim()).filter(t => t.length > 0))];
    const tagIdsRaw = await Promise.all(uniqueNames.map(tagName => getOrCreateTag(client, tagName)));
    const tagIds = tagIdsRaw.filter((tagId): tagId is number => tagId !== null);

    // Log warnings for any failed tag creations
    uniqueNames.forEach((tagName, index) => {
        if (tagIdsRaw[index] === null) {
            logger.warn(`Failed to create or retrieve tag: ${tagName}`);
        }
    });

    return tagIds;
}

export async function upsertMovies(
    client: AxiosInstance,
    movies: LetterboxdMovie[],
    options: RadarrUpsertOptions
): Promise<UpsertSummary> {
    const qualityProfileId = await getQualityProfileId(client, options.qualityProfile);

    if (!qualityProfileId) {
        throw new Error(`Quality profile "${options.qualityProfile}" not found in Radarr — the name must match exactly.`);
    }

    const rootFolderPath = !options.rootFolderId
        ? await getRootFolder(client)
        : await getRootFolderById(client, options.rootFolderId);

    if (!rootFolderPath) {
        throw new Error('Could not get root folder');
    }

    const tagIds = await getAllRequiredTagIds(client, options.tags);

    const results = await Bluebird.map(movies, movie =>
        addMovie(client, movie, {
            qualityProfileId,
            rootFolderPath,
            tagIds,
            minimumAvailability: options.minimumAvailability,
            monitored: options.monitored,
            dryRun: options.dryRun
        })
    );

    return {
        added: results.filter(r => r.status === 'added' || r.status === 'dryRun').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        failed: results.filter(r => r.status === 'failed').length,
        results
    };
}

interface AddMovieParams {
    qualityProfileId: number;
    rootFolderPath: string;
    tagIds: number[];
    minimumAvailability: string;
    monitored: boolean;
    dryRun: boolean;
}

export async function addMovie(
    client: AxiosInstance,
    movie: LetterboxdMovie,
    params: AddMovieParams
): Promise<AddResult> {
    try {
        logger.debug(`Adding movie to Radarr: ${movie.name}`);

        if (!movie.tmdbId) {
            logger.info(`Could not add movie ${movie.name} because no tmdb id was found. Is this a TV show?`);
            return { movie, status: 'skipped', reason: 'no tmdbId' };
        }

        const payload: RadarrMovie = {
            title: movie.name,
            qualityProfileId: params.qualityProfileId,
            rootFolderPath: params.rootFolderPath,
            tmdbId: parseInt(movie.tmdbId),
            minimumAvailability: params.minimumAvailability,
            monitored: params.monitored,
            tags: params.tagIds,
            addOptions: {
                searchForMovie: true
            }
        }

        if (params.dryRun) {
            logger.info(`[DRY RUN] Would add movie to Radarr: ${payload.title} (TMDB: ${payload.tmdbId}) ${JSON.stringify(payload)}`);
            return { movie, status: 'dryRun' };
        }

        const response = await client.post('/api/v3/movie', payload);

        logger.info(`Successfully added movie: ${payload.title} ${JSON.stringify(response.data)}`);
        return { movie, status: 'added', radarrMovieId: response.data?.id };
    } catch (e: any) {
        if (e.response?.status === 400 && (JSON.stringify(e.response?.data)).includes('This movie has already been added')) {
            logger.debug(`Movie ${movie.name} already exists in Radarr, skipping`);
            return { movie, status: 'skipped', reason: 'already in Radarr' };
        }
        logger.error(`Error adding movie ${movie.name} (TMDB: ${movie.tmdbId}): ${e?.message ?? e}`);
        return { movie, status: 'failed', reason: e?.message ?? 'unknown error' };
    }
}
