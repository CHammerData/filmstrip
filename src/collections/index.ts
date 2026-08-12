import { Movie } from '@prisma/client';
import { AxiosInstance } from 'axios';
import prisma from '../db/client';
import { ListWithUser } from '../db/config';
import {
  createJellyfinClient,
  getAllMovieProviderIds,
  findCollectionByName,
  getCollectionById,
  createCollection,
  renameCollection,
  getCollectionItemIds,
  addToCollection,
  removeFromCollection,
} from '../api/jellyfin';
import logger from '../util/logger';

/** Resolve each movie's Jellyfin item id, caching newly-found ones on Movie.jellyfinItemId so
 *  later runs don't need to re-fetch the whole Jellyfin library. */
async function resolveJellyfinItemIds(client: AxiosInstance, movies: Movie[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const unresolved: Movie[] = [];
  for (const m of movies) {
    if (m.jellyfinItemId) result.set(m.tmdbId, m.jellyfinItemId);
    else unresolved.push(m);
  }
  if (unresolved.length === 0) return result;

  const all = await getAllMovieProviderIds(client);
  const byTmdb = new Map(all.filter((i) => i.tmdbId !== null).map((i) => [i.tmdbId as number, i.id]));

  // Sequential: SQLite is single-writer, so a Promise.all fan-out of these caching writes can
  // contend for the write lock on a large collection (see scheduler's upsert loop).
  for (const m of unresolved) {
    const itemId = byTmdb.get(m.tmdbId);
    if (!itemId) continue;
    result.set(m.tmdbId, itemId);
    await prisma.movie.update({ where: { id: m.id }, data: { jellyfinItemId: itemId } });
  }

  return result;
}

/**
 * Maintain a Jellyfin collection (BoxSet) mirroring a list's current films (DESIGN.md §8).
 * Creates the collection on first use; otherwise diffs membership and adds/removes only what
 * changed. No-ops (with a warning) if Jellyfin isn't configured -- never blocks a Radarr sync.
 *
 * Tracks the collection by `List.jellyfinCollectionId` (identity), not by re-searching for
 * `collectionName` every run -- searching by name meant editing a list's label or
 * collectionNameOverride (which `collectionName` is derived from) made this stop finding the
 * existing collection and create a duplicate, stranding the old one in Jellyfin under its old
 * name. Once an id is known, a name mismatch is treated as a rename to apply, not a miss.
 */
export async function syncCollection(list: ListWithUser, collectionName: string): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.jellyfinUrl || !settings.jellyfinApiKey) {
    logger.warn(`makeCollection is on for list "${list.label}" but Jellyfin is not configured; skipping.`);
    return;
  }
  const client = createJellyfinClient({ url: settings.jellyfinUrl, apiKey: settings.jellyfinApiKey });

  const listMovies = await prisma.listMovie.findMany({
    where: { listId: list.id, presentOnList: true },
    include: { movie: true },
  });
  const movies = listMovies.map((lm) => lm.movie);

  const itemIdByTmdb = await resolveJellyfinItemIds(client, movies);
  const itemIds = movies.map((m) => itemIdByTmdb.get(m.tmdbId)).filter((id): id is string => !!id);

  // Prefer the stored id; a miss (never created, or deleted directly in Jellyfin since last sync)
  // falls back to a name search so a pre-existing collection -- from before jellyfinCollectionId
  // was tracked, or one an admin created by hand -- gets adopted instead of duplicated.
  let collection = list.jellyfinCollectionId ? await getCollectionById(client, list.jellyfinCollectionId) : null;
  if (!collection) {
    collection = await findCollectionByName(client, collectionName);
  }

  if (!collection) {
    if (itemIds.length === 0) return;
    const created = await createCollection(client, collectionName, itemIds);
    await prisma.list.update({ where: { id: list.id }, data: { jellyfinCollectionId: created.id } });
    logger.info(`Created Jellyfin collection "${collectionName}" with ${itemIds.length} film(s).`);
    return;
  }

  if (collection.id !== list.jellyfinCollectionId) {
    await prisma.list.update({ where: { id: list.id }, data: { jellyfinCollectionId: collection.id } });
  }
  if (collection.name !== collectionName) {
    await renameCollection(client, collection.id, collectionName);
    logger.info(`Renamed Jellyfin collection "${collection.name}" -> "${collectionName}".`);
  }

  const current = await getCollectionItemIds(client, collection.id);
  const toAdd = itemIds.filter((id) => !current.includes(id));
  const toRemove = current.filter((id) => !itemIds.includes(id));
  if (toAdd.length === 0 && toRemove.length === 0) return;

  await addToCollection(client, collection.id, toAdd);
  await removeFromCollection(client, collection.id, toRemove);
  logger.info(`Synced Jellyfin collection "${collectionName}": +${toAdd.length} -${toRemove.length}.`);
}
