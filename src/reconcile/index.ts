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
  /** left_list: must confirm no enabled list still wants it. watched: independent trigger —
   *  the film may still be on the list (DESIGN.md §6: "queue on watch", not "remove from list"). */
  reason: 'left_list' | 'watched';
  triggeredByListId: number;
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
  logger.info(
    `Marked "${radarrMovie.title}" for deletion review (${candidate.reason === 'watched' ? 'watched' : 'left all lists'}).`
  );
}

/**
 * Reconcile one list after a sync: any film previously present that's no longer in this
 * scrape gets presentOnList=false, then is run through the keeper-rule. Never throws —
 * a failure evaluating one film is logged and the rest still run.
 */
export async function reconcileList(list: ListWithUser, currentTmdbIds: Set<number>): Promise<void> {
  const existing = await prisma.listMovie.findMany({
    where: { listId: list.id, presentOnList: true },
    select: { id: true, movieId: true, movie: { select: { tmdbId: true } } },
  });
  const droppedOff = existing.filter((lm) => !currentTmdbIds.has(lm.movie.tmdbId));
  if (droppedOff.length === 0) return;

  await Promise.all(
    droppedOff.map((lm) =>
      prisma.listMovie.update({
        where: { id: lm.id },
        data: { presentOnList: false, removedFromListAt: new Date() },
      })
    )
  );

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
