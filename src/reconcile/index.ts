import prisma from '../db/client';
import { GLOBAL_TAG, parseExtraTags, ListWithUser } from '../db/config';
import {
  createRadarrClient,
  getMovieById,
  getAllTags,
  setMonitored,
  deleteMovie,
} from '../api/radarr';
import logger from '../util/logger';

/** Build a Radarr client from the singleton Settings row. Throws if unconfigured. */
async function radarrClientFromSettings() {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.radarrUrl || !settings.radarrApiKey) {
    throw new Error('Radarr connection is not configured. Set radarrUrl and radarrApiKey in Settings.');
  }
  return createRadarrClient({ url: settings.radarrUrl, apiKey: settings.radarrApiKey });
}

/** Every Radarr tag label Filmstrip itself manages (user tags + global + any list's extraTags). */
async function getKnownTagLabels(): Promise<Set<string>> {
  const [users, lists] = await Promise.all([prisma.user.findMany(), prisma.list.findMany()]);
  return new Set([
    GLOBAL_TAG,
    ...users.map((u) => u.tag),
    ...lists.flatMap((l) => parseExtraTags(l.extraTags)),
  ]);
}

interface DeletionCandidate {
  /** left_list: film dropped off a list that still exists. watched: owner watched it (may still be
   *  on the list — DESIGN.md §6). list_deleted: its list was deleted (no triggering list remains). */
  reason: 'left_list' | 'watched' | 'list_deleted';
  /** The list whose event triggered this, or null when it no longer exists (list_deleted). */
  triggeredByListId: number | null;
  requireNotWanted: boolean;
}

/**
 * The keeper-rule (DESIGN.md §5): is this film a removal candidate? If so, unmonitor it in
 * Radarr (file kept) and open a pending DeletionRequest. No-ops if the film is still wanted
 * (when required), not Filmstrip's to manage, already pinned, already pending, or carries a
 * foreign tag.
 */
async function evaluateForDeletion(movieId: number, candidate: DeletionCandidate): Promise<void> {
  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (!movie || !movie.addedByFilmstrip || movie.pinned) return;

  if (candidate.requireNotWanted) {
    const stillWanted = await prisma.listMovie.findFirst({
      where: { movieId, presentOnList: true, list: { enabled: true } },
    });
    if (stillWanted) return;
  }

  const alreadyPending = await prisma.deletionRequest.findFirst({
    where: { movieId, status: 'pending' },
  });
  if (alreadyPending) return;

  if (!movie.radarrMovieId) {
    logger.warn(`Movie id=${movieId} (tmdb=${movie.tmdbId}) has no radarrMovieId; skipping.`);
    return;
  }

  const client = await radarrClientFromSettings();
  const radarrMovie = await getMovieById(client, movie.radarrMovieId);
  if (!radarrMovie) {
    logger.warn(`Movie id=${movieId} not found in Radarr (id=${movie.radarrMovieId}); skipping.`);
    return;
  }

  const knownTags = await getKnownTagLabels();
  const allTags = await getAllTags(client);
  const hasForeignTag = radarrMovie.tags.some((tagId) => {
    const label = allTags.find((t) => t.id === tagId)?.label;
    return !label || !knownTags.has(label);
  });
  if (hasForeignTag) {
    logger.info(`"${radarrMovie.title}" carries a foreign tag; never eligible for removal.`);
    return;
  }

  await setMonitored(client, radarrMovie, false);
  await prisma.deletionRequest.create({
    data: { movieId, reason: candidate.reason, triggeredByListId: candidate.triggeredByListId, status: 'pending' },
  });
  const why =
    candidate.reason === 'watched'
      ? 'watched'
      : candidate.reason === 'list_deleted'
        ? 'its list was deleted'
        : 'left all lists';
  logger.info(`Marked "${radarrMovie.title}" for deletion review (${why}).`);
}

// A single scrape that would drop more than half of a list's currently-tracked films (and at
// least this many) is more likely a broken/interstitial page load -- a bot-check or transient
// near-empty render can return HTTP 200 with only a handful of links -- than a genuine mass
// removal from the Letterboxd list. Below this count, dropping is always trusted: removing one
// or two films from a small list is the overwhelmingly common real edit, not a bad scrape.
const MASS_DROP_MIN_COUNT = 3;
const MASS_DROP_RATIO = 0.5;

/**
 * Reconcile one list after a sync: any film previously present that's no longer in this scrape
 * gets presentOnList=false and runs through the keeper-rule; any film previously marked gone
 * that's back in this scrape gets presentOnList restored. Refuses to apply a drop that looks
 * like a broken scrape rather than a real edit (see MASS_DROP_*). Never throws — a failure
 * evaluating one film is logged and the rest still run.
 */
export async function reconcileList(list: ListWithUser, currentTmdbIds: Set<number>): Promise<void> {
  const existing = await prisma.listMovie.findMany({
    where: { listId: list.id },
    select: { id: true, movieId: true, presentOnList: true, movie: { select: { tmdbId: true } } },
  });

  const currentlyPresent = existing.filter((lm) => lm.presentOnList);
  const droppedOff = currentlyPresent.filter((lm) => !currentTmdbIds.has(lm.movie.tmdbId));
  const returned = existing.filter((lm) => !lm.presentOnList && currentTmdbIds.has(lm.movie.tmdbId));

  // Sequential: SQLite is single-writer, so fanning these updates out with Promise.all can contend
  // for the write lock on a list with many changes at once (see scheduler's upsert loop).
  for (const lm of returned) {
    await prisma.listMovie.update({
      where: { id: lm.id },
      data: { presentOnList: true, removedFromListAt: null, lastSeenAt: new Date() },
    });
  }

  if (droppedOff.length === 0) return;

  if (droppedOff.length >= MASS_DROP_MIN_COUNT && droppedOff.length / currentlyPresent.length > MASS_DROP_RATIO) {
    logger.warn(
      `Reconcile: scrape for list "${list.label}" would drop ${droppedOff.length}/${currentlyPresent.length} ` +
        `tracked film(s) at once -- treating as a broken scrape and skipping this run's drop.`
    );
    return;
  }

  for (const lm of droppedOff) {
    await prisma.listMovie.update({
      where: { id: lm.id },
      data: { presentOnList: false, removedFromListAt: new Date() },
    });
  }

  for (const lm of droppedOff) {
    try {
      await evaluateForDeletion(lm.movieId, {
        reason: 'left_list',
        triggeredByListId: list.id,
        requireNotWanted: true,
      });
    } catch (e: any) {
      logger.error(`Reconcile: failed evaluating movie id=${lm.movieId}:`, e?.message ?? e);
    }
  }
}

/**
 * removeOnWatch (DESIGN.md §6-§7): for a list with that toggle on, queue for deletion review
 * any film still on the list that the owner has now watched. Unlike reconcileList, this doesn't
 * require the film to have left the list — being watched is its own independent trigger.
 */
export async function reconcileWatched(list: ListWithUser, watchedTmdbIds: Set<number>): Promise<void> {
  if (watchedTmdbIds.size === 0) return;

  const current = await prisma.listMovie.findMany({
    where: { listId: list.id, presentOnList: true },
    select: { movieId: true, movie: { select: { tmdbId: true } } },
  });
  const watched = current.filter((lm) => watchedTmdbIds.has(lm.movie.tmdbId));

  for (const lm of watched) {
    try {
      await evaluateForDeletion(lm.movieId, {
        reason: 'watched',
        triggeredByListId: list.id,
        requireNotWanted: false,
      });
    } catch (e: any) {
      logger.error(`Reconcile (watched): failed evaluating movie id=${lm.movieId}:`, e?.message ?? e);
    }
  }
}

/**
 * Delete a list and handle the films it held (DESIGN.md §4/§6):
 * - `permanence` on  → pin the films Filmstrip added, so the keeper-rule never removes them;
 * - `permanence` off → run each through the keeper-rule (reason `list_deleted`), queueing those
 *   no other enabled list still wants.
 * The list row and its `ListMovie` membership are removed either way. Membership is captured
 * *before* deletion (it cascades away), then the keeper-rule runs *after* — so a film correctly
 * reads as "no longer on this list". Never throws mid-film; throws only if the list is absent.
 */
export async function deleteList(listId: number): Promise<void> {
  const list = await prisma.list.findUnique({ where: { id: listId } });
  if (!list) throw new Error(`List id=${listId} not found.`);

  const members = await prisma.listMovie.findMany({
    where: { listId },
    select: { movieId: true, movie: { select: { addedByFilmstrip: true } } },
  });

  await prisma.list.delete({ where: { id: listId } }); // cascade-removes this list's ListMovie rows

  if (list.permanence) {
    const toPin = members.filter((m) => m.movie.addedByFilmstrip).map((m) => m.movieId);
    if (toPin.length > 0) {
      await prisma.movie.updateMany({ where: { id: { in: toPin } }, data: { pinned: true } });
    }
    logger.info(`List "${list.label}" deleted (permanence on): pinned ${toPin.length} film(s).`);
    return;
  }

  for (const m of members) {
    try {
      await evaluateForDeletion(m.movieId, {
        reason: 'list_deleted',
        triggeredByListId: null,
        requireNotWanted: true,
      });
    } catch (e: any) {
      logger.error(`List-delete: failed evaluating movie id=${m.movieId}:`, e?.message ?? e);
    }
  }
}

/** Approve a pending DeletionRequest: delete from Radarr (and the file, per the triggering
 *  list's deleteFiles setting, default true), then mark the request resolved. */
export async function approveDeletion(requestId: number): Promise<void> {
  const request = await prisma.deletionRequest.findUnique({
    where: { id: requestId },
    include: { movie: true, triggeredByList: true },
  });
  if (!request) throw new Error(`DeletionRequest id=${requestId} not found.`);
  if (request.status !== 'pending') {
    throw new Error(`DeletionRequest id=${requestId} is already ${request.status}.`);
  }
  if (!request.movie.radarrMovieId) {
    throw new Error(`Movie id=${request.movieId} has no radarrMovieId.`);
  }

  const client = await radarrClientFromSettings();
  const deleteFiles = request.triggeredByList?.deleteFiles ?? true;
  await deleteMovie(client, request.movie.radarrMovieId, deleteFiles);

  await prisma.deletionRequest.update({
    where: { id: requestId },
    data: { status: 'approved', resolvedAt: new Date() },
  });
}

/** Keep a pending DeletionRequest: pin the film (never resurfaces) and mark it resolved. */
export async function keepDeletion(requestId: number): Promise<void> {
  const request = await prisma.deletionRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`DeletionRequest id=${requestId} not found.`);
  if (request.status !== 'pending') {
    throw new Error(`DeletionRequest id=${requestId} is already ${request.status}.`);
  }

  await prisma.movie.update({ where: { id: request.movieId }, data: { pinned: true } });
  await prisma.deletionRequest.update({
    where: { id: requestId },
    data: { status: 'kept', resolvedAt: new Date() },
  });
}
