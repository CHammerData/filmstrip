/**
 * Exercises the real Jellyfin API client against a live Jellyfin instance (not mocks).
 * Requires JELLYFIN_TEST_URL + JELLYFIN_TEST_API_KEY -- provided by
 * .github/workflows/live-api-test.yml, which boots a throwaway
 * lscr.io/linuxserver/jellyfin container, drives its first-run setup wizard, and
 * mints an API key. Skips entirely (not a failure) when unset.
 *
 * The library is empty (no media files) in this instance, so what's verified here is wire
 * compatibility (paths, params, auth header, response shape) rather than end-to-end media
 * matching -- there's no practical way to get real scanned movies into Jellyfin in CI without
 * shipping video fixtures. Movie-provider-id resolution and watched-state are exercised
 * against src/watched and src/collections at the unit level (mocked); this suite is the
 * live-wire check for src/api/jellyfin.ts itself.
 */
import {
  createJellyfinClient,
  getWatchedTmdbIds,
  getAllMovieProviderIds,
  findCollectionByName,
  createCollection,
  getCollectionItemIds,
  addToCollection,
  removeFromCollection,
} from './jellyfin';

const JELLYFIN_TEST_URL = process.env.JELLYFIN_TEST_URL;
const JELLYFIN_TEST_API_KEY = process.env.JELLYFIN_TEST_API_KEY;
const RUN = !!JELLYFIN_TEST_URL && !!JELLYFIN_TEST_API_KEY;

const COLLECTION_NAME = 'Filmstrip Live Test Collection';

(RUN ? describe : describe.skip)('jellyfin API (live)', () => {
  jest.setTimeout(60000);

  const client = createJellyfinClient({ url: JELLYFIN_TEST_URL!, apiKey: JELLYFIN_TEST_API_KEY! });
  let userId: string;
  let collectionId: string;

  it('lists an empty movie library without erroring', async () => {
    const items = await getAllMovieProviderIds(client);
    expect(items).toEqual([]);
  });

  it('resolves the admin user id and reports an empty watched set', async () => {
    const users = await client.get('/Users');
    userId = users.data[0].Id;
    expect(userId).toBeTruthy();

    const watched = await getWatchedTmdbIds(client, userId);
    expect(watched).toEqual(new Set());
  });

  it('finds no collection before one exists', async () => {
    const found = await findCollectionByName(client, COLLECTION_NAME);
    expect(found).toBeNull();
  });

  it('creates a collection', async () => {
    const created = await createCollection(client, COLLECTION_NAME, []);
    expect(created.id).toBeTruthy();
    collectionId = created.id;
  });

  it('finds the collection by name afterward', async () => {
    const found = await findCollectionByName(client, COLLECTION_NAME);
    expect(found).toEqual({ id: collectionId });
  });

  it('reports empty membership for a freshly-created collection', async () => {
    const items = await getCollectionItemIds(client, collectionId);
    expect(items).toEqual([]);
  });

  it('no-ops add/remove with an empty id list', async () => {
    await addToCollection(client, collectionId, []);
    await removeFromCollection(client, collectionId, []);

    const items = await getCollectionItemIds(client, collectionId);
    expect(items).toEqual([]);
  });
});
