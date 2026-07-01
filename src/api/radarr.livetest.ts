/**
 * Exercises the real Radarr API client against a live Radarr instance (not mocks).
 * Requires RADARR_TEST_URL + RADARR_TEST_API_KEY -- provided by
 * .github/workflows/live-api-test.yml, which boots a throwaway
 * lscr.io/linuxserver/radarr container and pre-seeds the API key via
 * RADARR__AUTH__APIKEY. Skips entirely (not a failure) when unset, so this
 * is safe to leave in a normal `npm test` run without Docker.
 */
import {
  createRadarrClient,
  getQualityProfileId,
  getRootFolder,
  getAllRequiredTagIds,
  getAllTags,
  addMovie,
  getMovieById,
  setMonitored,
  deleteMovie,
} from './radarr';

const RADARR_TEST_URL = process.env.RADARR_TEST_URL;
const RADARR_TEST_API_KEY = process.env.RADARR_TEST_API_KEY;
const RUN = !!RADARR_TEST_URL && !!RADARR_TEST_API_KEY;

// A well-known, stable TMDB id (Fight Club) -- exists in Radarr's own metadata lookup.
const TMDB_ID = 550;

(RUN ? describe : describe.skip)('radarr API (live)', () => {
  jest.setTimeout(60000);

  const client = createRadarrClient({ url: RADARR_TEST_URL!, apiKey: RADARR_TEST_API_KEY! });
  let qualityProfileId: number;
  let rootFolderPath: string;
  let radarrMovieId: number;

  it('resolves a quality profile and root folder', async () => {
    const profiles = await client.get('/api/v3/qualityprofile');
    const anyProfile = profiles.data[0];
    qualityProfileId = (await getQualityProfileId(client, anyProfile.name))!;
    expect(qualityProfileId).toBe(anyProfile.id);

    rootFolderPath = (await getRootFolder(client))!;
    expect(rootFolderPath).toBeTruthy();
  });

  it('creates and reuses a tag', async () => {
    const tagIds = await getAllRequiredTagIds(client, ['filmstrip-live-test']);
    expect(tagIds).toHaveLength(1);

    const allTags = await getAllTags(client);
    expect(allTags.some((t) => t.label === 'filmstrip-live-test')).toBe(true);
  });

  it('adds a movie by tmdbId', async () => {
    const result = await addMovie(
      client,
      { id: 1, name: 'Fight Club', slug: '/film/fight-club/', tmdbId: String(TMDB_ID), imdbId: null, publishedYear: 1999 },
      {
        qualityProfileId,
        rootFolderPath,
        tagIds: [],
        minimumAvailability: 'released',
        monitored: true,
        dryRun: false,
      }
    );

    expect(result.status).toBe('added');
    expect(result.radarrMovieId).toBeDefined();
    radarrMovieId = result.radarrMovieId!;
  });

  it('treats a duplicate add as skipped', async () => {
    const result = await addMovie(
      client,
      { id: 1, name: 'Fight Club', slug: '/film/fight-club/', tmdbId: String(TMDB_ID), imdbId: null, publishedYear: 1999 },
      {
        qualityProfileId,
        rootFolderPath,
        tagIds: [],
        minimumAvailability: 'released',
        monitored: true,
        dryRun: false,
      }
    );

    expect(result.status).toBe('skipped');
  });

  it('fetches the movie by id and reports it monitored', async () => {
    const movie = await getMovieById(client, radarrMovieId);
    expect(movie).not.toBeNull();
    expect(movie!.monitored).toBe(true);
    expect(movie!.tmdbId).toBe(TMDB_ID);
  });

  it('unmonitors the movie via a full-resource PUT', async () => {
    const movie = await getMovieById(client, radarrMovieId);
    await setMonitored(client, movie!, false);

    const updated = await getMovieById(client, radarrMovieId);
    expect(updated!.monitored).toBe(false);
  });

  it('deletes the movie', async () => {
    await deleteMovie(client, radarrMovieId, false);

    const gone = await getMovieById(client, radarrMovieId);
    expect(gone).toBeNull();
  });
});
