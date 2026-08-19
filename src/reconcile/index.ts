import prisma from '../db/client';
import { GLOBAL_TAG, parseExtraTags, ListWithUser } from '../db/config';
import {
  createRadarrClient,
  getMovieById,
  getMovieByTmdbId,
  getAllTags,
  setMonitored,
  deleteMovie,
} from '../api/radarr';
import { createJellyfinClient, deleteCollection } from '../api/jellyfin';
import { getDiaryWatchedDates } from '../watched';
import { transitionMovie, logMovieEvent } from '../movieState';
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

/** A list "claims" a film (DESIGN.md §5) when its ListMovie row says the film is present and not
 *  film-level excluded. The shared predicate behind the keeper-rule's "still wanted" check and
 *  behind permanence -- both are just different readings of the same live claim data. */
const LIVE_CLAIM_WHERE = { presentOnList: true, excluded: false } as const;

/** Does any enabled list currently claim this film? */
async function hasClaim(movieId: number): Promise<boolean> {
  const claim = await prisma.listMovie.findFirst({
    where: { ...LIVE_CLAIM_WHERE, movieId, list: { enabled: true } },
  });
  return !!claim;
}

/** Does any enabled list *without* removeOnWatch currently claim this film? A list that itself
 *  wants the film gone the moment it's watched isn't grounds to un-queue a `watched` candidate --
 *  only a claim from a list that doesn't care about watch-state falsifies it (DESIGN.md §6-§7). */
async function hasOrdinaryClaim(movieId: number): Promise<boolean> {
  const claim = await prisma.listMovie.findFirst({
    where: { ...LIVE_CLAIM_WHERE, movieId, list: { enabled: true, removeOnWatch: false } },
  });
  return !!claim;
}

/**
 * Which single user's lists ever added this film, if there's exactly one -- lets a non-admin see
 * and resolve deletion requests for films only their own lists ever added, without seeing/touching
 * anyone else's. Looks at *every* `ListMovie` row ever created for the movie, not just
 * currently-present ones -- a `left_list`/`watched` request's triggering list still has its row
 * intact. Returns null when zero or more than one distinct owner is found -- including the edge
 * case where the sole contributing list has since been deleted (its `ListMovie` rows cascade away
 * with it, `deleteList` above), which degrades to admin-only visibility rather than guessing,
 * matching how the rest of this module derives everything from current DB state.
 */
export async function getSoleOwnerUserId(movieId: number): Promise<number | null> {
  const rows = await prisma.listMovie.findMany({
    where: { movieId },
    select: { list: { select: { userId: true } } },
  });
  const owners = new Set(rows.map((r) => r.list.userId));
  return owners.size === 1 ? [...owners][0] : null;
}

interface DeletionCandidate {
  /** left_list: film dropped off a list that still exists. watched: owner watched it (may still be
   *  on the list — DESIGN.md §6). list_deleted: its list was deleted. list_deactivated: its list
   *  was disabled. Either way, no triggering list remains for list_deleted/list_deactivated once
   *  they're the *last* claim dropped. */
  reason: 'left_list' | 'watched' | 'list_deleted' | 'list_deactivated';
  /** The list whose event triggered this, or null when it no longer exists (list_deleted). */
  triggeredByListId: number | null;
  requireNotWanted: boolean;
}

/**
 * The keeper-rule (DESIGN.md §5): is this film a removal candidate? If so, unmonitor it in
 * Radarr (file kept), transition it to deletion_queued, and open a pending DeletionRequest.
 * No-ops if the film is still wanted (when required), isn't currently `added` (covers not
 * Filmstrip's to manage, already queued/deleted/kept), or carries a foreign tag.
 */
async function evaluateForDeletion(movieId: number, candidate: DeletionCandidate): Promise<void> {
  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (!movie || movie.state !== 'added') return;

  if (candidate.requireNotWanted) {
    if (await hasClaim(movieId)) return;
  }

  const client = await radarrClientFromSettings();

  let radarrMovieId = movie.radarrMovieId;
  if (!radarrMovieId) {
    // A movie can end up `added` with no radarrMovieId on record if Radarr's create response
    // didn't carry one back at add time (src/scheduler/index.ts only persists it when the add
    // result actually included one) -- observed live across several films on one instance, all
    // stuck permanently `added` with this exact warning repeating every sync. Radarr genuinely has
    // the film either way (that's how it got to `added` in the first place); resolve the id by
    // tmdbId and backfill it rather than leaving the film unrecoverable.
    const found = await getMovieByTmdbId(client, movie.tmdbId);
    if (!found) {
      logger.warn(
        `Movie id=${movieId} (tmdb=${movie.tmdbId}) has no radarrMovieId and isn't found in Radarr by tmdbId; skipping.`
      );
      return;
    }
    radarrMovieId = found.id;
    await prisma.movie.update({ where: { id: movieId }, data: { radarrMovieId } });
    logger.info(
      `Movie id=${movieId} (tmdb=${movie.tmdbId}) had no radarrMovieId on record; backfilled as id=${radarrMovieId} from Radarr.`
    );
  }

  const radarrMovie = await getMovieById(client, radarrMovieId);
  if (!radarrMovie) {
    logger.warn(`Movie id=${movieId} not found in Radarr (id=${radarrMovieId}); skipping.`);
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
  // Re-check-and-transition atomically: the gap between the state check above and here spans
  // several awaited Radarr calls, wide enough for two concurrent evaluations of the same movie
  // (e.g. a manual "sync now" overlapping the scheduler tick) to both pass the early check before
  // either transitions it. Re-checking state inside the transaction closes that window.
  const transitioned = await prisma.$transaction(async (tx) => {
    const current = await tx.movie.findUnique({ where: { id: movieId } });
    if (!current || current.state !== 'added') return false;
    await transitionMovie(tx, movieId, 'deletion_queued', {
      type: 'deletion_queued',
      detail: candidate.reason,
      listId: candidate.triggeredByListId ?? undefined,
    });
    await tx.deletionRequest.create({
      data: { movieId, reason: candidate.reason, triggeredByListId: candidate.triggeredByListId, status: 'pending' },
    });
    return true;
  });
  if (!transitioned) return;

  const why =
    candidate.reason === 'watched'
      ? 'watched'
      : candidate.reason === 'list_deleted'
        ? 'its list was deleted'
        : candidate.reason === 'list_deactivated'
          ? 'its list was disabled'
          : 'left all lists';
  logger.info(`Marked "${radarrMovie.title}" for deletion review (${why}).`);
}

/**
 * A pending DeletionRequest's premise can become false again before a human resolves it (DESIGN.md
 * §5-§6): `left_list`/`list_deleted`/`list_deactivated`/`manual_reopen` are all falsified by *any*
 * remaining claim -- their premise was "nobody wants this film," full stop. `watched` is falsified
 * only by an *ordinary* claim (a list without removeOnWatch) -- a list that itself wants the film
 * gone on watch isn't grounds to un-queue a watched-triggered request. Cancels every matching
 * pending request whose premise no longer holds, transitions back to `added`, and re-monitors in
 * Radarr (evaluateForDeletion unmonitored it when the request was raised). Sweeps every matching
 * pending request for the movie, not just one. Never throws — logged and skipped on failure.
 */
async function cancelStaleDeletionRequests(movieId: number): Promise<void> {
  const pending = await prisma.deletionRequest.findMany({
    where: {
      movieId,
      status: 'pending',
      reason: { in: ['left_list', 'list_deleted', 'list_deactivated', 'manual_reopen', 'watched'] },
    },
  });
  if (pending.length === 0) return;

  const toCancel: number[] = [];
  for (const req of pending) {
    const stillHolds = req.reason === 'watched' ? await hasOrdinaryClaim(movieId) : await hasClaim(movieId);
    if (stillHolds) toCancel.push(req.id);
  }
  if (toCancel.length === 0) return;

  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (movie?.radarrMovieId) {
    try {
      const client = await radarrClientFromSettings();
      const radarrMovie = await getMovieById(client, movie.radarrMovieId);
      if (radarrMovie) await setMonitored(client, radarrMovie, true);
    } catch (e: any) {
      logger.error(
        `Reconcile: failed to re-monitor movie id=${movieId} while cancelling its stale deletion request:`,
        e?.message ?? e
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.deletionRequest.deleteMany({ where: { id: { in: toCancel } } });
    if (movie && movie.state === 'deletion_queued') {
      await transitionMovie(tx, movieId, 'added', {
        type: 'deletion_queue_cancelled',
        detail: 'confirmed still claimed',
      });
    }
  });
  logger.info(
    `Cancelled ${toCancel.length} stale deletion request(s) for movie id=${movieId} -- claim reinstated.`
  );
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
 * that's back in this scrape gets presentOnList restored (and, if it was 'deleted', revived to
 * 'wanted' so the scheduler retries adding it — a real re-add, not a duplicate, since Radarr
 * genuinely doesn't have it anymore), and any pending left_list request whose claim no longer
 * holds is cancelled — checked for every film confirmed present this run, not just ones that just
 * returned, so a request left stranded by a past bad scrape (from before this existed) still
 * self-heals. Refuses to apply a drop that looks like a broken scrape rather than a real edit (see
 * MASS_DROP_*). Never throws — a failure evaluating one film is logged and the rest still run.
 */
export async function reconcileList(list: ListWithUser, currentTmdbIds: Set<number>): Promise<void> {
  const existing = await prisma.listMovie.findMany({
    where: { listId: list.id },
    select: {
      id: true,
      movieId: true,
      presentOnList: true,
      movie: { select: { tmdbId: true, state: true } },
    },
  });

  const currentlyPresent = existing.filter((lm) => lm.presentOnList);
  const droppedOff = currentlyPresent.filter((lm) => !currentTmdbIds.has(lm.movie.tmdbId));
  const returned = existing.filter((lm) => !lm.presentOnList && currentTmdbIds.has(lm.movie.tmdbId));
  const stillWanted = existing.filter((lm) => currentTmdbIds.has(lm.movie.tmdbId));

  // Sequential: SQLite is single-writer, so fanning these updates out with Promise.all can contend
  // for the write lock on a list with many changes at once (see scheduler's upsert loop).
  for (const lm of returned) {
    await prisma.$transaction(async (tx) => {
      await tx.listMovie.update({
        where: { id: lm.id },
        data: { presentOnList: true, removedFromListAt: null, lastSeenAt: new Date() },
      });
      await logMovieEvent(tx, lm.movieId, { type: 'restored_to_list', listId: list.id });
      // A deleted film reappearing on a list is a genuine re-add -- Radarr doesn't have it
      // anymore, so this isn't a duplicate. Revive it to 'wanted' so the scheduler's dedup
      // (which skips anything not 'wanted') lets the next sync retry adding it.
      if (lm.movie.state === 'deleted') {
        await transitionMovie(tx, lm.movieId, 'wanted', {
          type: 'revived',
          detail: 'reappeared on a list after being deleted -- will be retried',
          listId: list.id,
        });
      }
    });
  }

  for (const lm of stillWanted) {
    try {
      await cancelStaleDeletionRequests(lm.movieId);
    } catch (e: any) {
      logger.error(`Reconcile: failed checking stale deletion requests for movie id=${lm.movieId}: ${e?.message ?? e}`);
    }
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
    await prisma.$transaction(async (tx) => {
      await tx.listMovie.update({
        where: { id: lm.id },
        data: { presentOnList: false, removedFromListAt: new Date() },
      });
      await logMovieEvent(tx, lm.movieId, { type: 'left_list', listId: list.id });
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
      logger.error(`Reconcile: failed evaluating movie id=${lm.movieId}: ${e?.message ?? e}`);
    }
  }
}

/**
 * removeOnWatch (DESIGN.md §6-§7): for a list with that toggle on, queue for deletion review any
 * film still claimed by this list whose *diary-logged* watch date is real and postdates this
 * list's own firstSeenAt for it (a presence-only aggregate/Jellyfin watch, or a diary date that
 * predates this list tracking the film, can't be told "just watched" from "watched years ago" --
 * DESIGN.md §7) -- unless another enabled, non-removeOnWatch list still ordinarily claims it (that
 * list's claim takes precedence over this one's watch-triggered drop). Unlike reconcileList, this
 * doesn't require the film to have left the list — being watched is its own independent trigger.
 * Logs a `watch_dropped` history event for every film this list drops on watch, regardless of
 * whether the aggregate keeper-rule ends up queuing it (DESIGN.md §5).
 *
 * The diary only carries a calendar day (midnight UTC, see `DiaryScraper`), while firstSeenAt is a
 * real timestamp -- comparing them directly made a same-day watch (added and diary-logged the same
 * day, the common case for a film that gets watched right after it downloads) almost always read as
 * "predates firstSeenAt" purely because midnight is earlier than whatever time of day the film was
 * added. Truncating firstSeenAt to its own UTC day before comparing fixes that while still excluding
 * a diary date from a genuinely earlier day.
 */
export async function reconcileWatched(list: ListWithUser, diaryWatchedDates: Map<number, Date>): Promise<void> {
  if (diaryWatchedDates.size === 0) return;

  const current = await prisma.listMovie.findMany({
    where: { listId: list.id, ...LIVE_CLAIM_WHERE },
    select: { movieId: true, firstSeenAt: true, movie: { select: { tmdbId: true, state: true } } },
  });

  for (const lm of current) {
    // Once this movie has left `added` (queued/deleted/kept/pre_existing/wanted -- any reason),
    // there is nothing left for this check to drop; re-running it every sync forever for a film
    // that's already resolved is exactly the "identical event every sync" spam this used to
    // produce once evaluateForDeletion's own gate started silently no-opping underneath it.
    if (lm.movie.state !== 'added') continue;

    const watchedAt = diaryWatchedDates.get(lm.movie.tmdbId);
    if (!watchedAt) continue;
    const firstSeenDay = Date.UTC(
      lm.firstSeenAt.getUTCFullYear(),
      lm.firstSeenAt.getUTCMonth(),
      lm.firstSeenAt.getUTCDate()
    );
    if (watchedAt.getTime() < firstSeenDay) continue;
    if (await hasOrdinaryClaim(lm.movieId)) continue;

    try {
      // Still `added` and still meets the drop condition: either this is the first time, or a
      // prior attempt couldn't actually queue it (a foreign Radarr tag, a stale radarrMovieId,
      // Radarr unreachable -- evaluateForDeletion logs the specific reason and returns without
      // throwing) and this sync is retrying. Retrying is correct -- a transient failure should
      // get another shot -- but re-logging an identical watch_dropped MovieEvent on every one of
      // those retries, forever, is not: only log it when it's new information, i.e. the most
      // recent event for this film isn't already this same list's watch_dropped.
      const lastEvent = await prisma.movieEvent.findFirst({
        where: { movieId: lm.movieId },
        orderBy: { createdAt: 'desc' },
      });
      if (lastEvent?.type !== 'watch_dropped' || lastEvent.listId !== list.id) {
        await prisma.$transaction((tx) =>
          logMovieEvent(tx, lm.movieId, {
            type: 'watch_dropped',
            listId: list.id,
            detail: `owner watched this film; list "${list.label}" (removeOnWatch) drops its claim`,
          })
        );
      }
      await evaluateForDeletion(lm.movieId, {
        reason: 'watched',
        triggeredByListId: list.id,
        requireNotWanted: false,
      });
    } catch (e: any) {
      logger.error(`Reconcile (watched): failed evaluating movie id=${lm.movieId}: ${e?.message ?? e}`);
    }
  }
}

/** Delete a deleted list's mirrored Jellyfin collection, if it had one (DESIGN.md §8) -- otherwise
 *  the BoxSet is stranded in Jellyfin with nothing left in Filmstrip that owns or updates it.
 *  No-ops quietly if makeCollection was off, no collection was ever created, or Jellyfin isn't
 *  configured; never throws -- this runs after the list row is already gone. */
async function deleteListsCollection(list: {
  label: string;
  makeCollection: boolean;
  jellyfinCollectionId: string | null;
}): Promise<void> {
  if (!list.makeCollection || !list.jellyfinCollectionId) return;
  try {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings?.jellyfinUrl || !settings.jellyfinApiKey) return;
    const client = createJellyfinClient({ url: settings.jellyfinUrl, apiKey: settings.jellyfinApiKey });
    await deleteCollection(client, list.jellyfinCollectionId);
    logger.info(`Deleted Jellyfin collection for list "${list.label}" (id=${list.jellyfinCollectionId}).`);
  } catch (e: any) {
    logger.error(`Failed to delete Jellyfin collection for list "${list.label}": ${e?.message ?? e}`);
  }
}

/**
 * Delete a list and handle the films it held (DESIGN.md §4/§6):
 * - `permanence` on  → pin the films Filmstrip added, so the keeper-rule never removes them;
 * - `permanence` off → run each through the keeper-rule (reason `list_deleted`), queueing those
 *   no other enabled list still wants.
 * Every member gets a `list_deleted` claim-drop history event first, regardless of branch or of
 * whether another list still claims it (DESIGN.md §5) -- logged *before* the list row is deleted,
 * since `listId` can only be set while the list still exists (it reads back null afterward, same
 * as any list-scoped event once its list is gone). The list row and its `ListMovie` membership are
 * removed either way. Membership is captured *before* deletion (it cascades away), then the
 * keeper-rule runs *after* — so a film correctly reads as "no longer on this list". Never throws
 * mid-film; throws only if the list is absent.
 */
export async function deleteList(listId: number): Promise<void> {
  const list = await prisma.list.findUnique({ where: { id: listId } });
  if (!list) throw new Error(`List id=${listId} not found.`);

  const members = await prisma.listMovie.findMany({
    where: { listId },
    select: { movieId: true, movie: { select: { state: true } } },
  });

  for (const m of members) {
    await prisma.$transaction((tx) =>
      logMovieEvent(tx, m.movieId, {
        type: 'list_deleted',
        listId,
        detail: `list "${list.label}" was deleted`,
      })
    );
  }

  await prisma.list.delete({ where: { id: listId } }); // cascade-removes this list's ListMovie rows
  await deleteListsCollection(list);

  if (list.permanence) {
    // "Filmstrip-managed" here means it was ever confirmed added (added/deletion_queued/deleted/
    // kept) -- excludes pre_existing (never Filmstrip's), wanted (not yet confirmed), and already-
    // kept (most commonly via live permanence pinning during a prior sync -- re-pinning would just
    // fire a redundant kept event and a no-op state write).
    const toPin = members
      .filter((m) => m.movie.state !== 'pre_existing' && m.movie.state !== 'wanted' && m.movie.state !== 'kept')
      .map((m) => m.movieId);
    for (const movieId of toPin) {
      await prisma.$transaction((tx) =>
        transitionMovie(tx, movieId, 'kept', {
          type: 'kept',
          detail: `list "${list.label}" deleted with permanence on`,
        })
      );
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
      logger.error(`List-delete: failed evaluating movie id=${m.movieId}: ${e?.message ?? e}`);
    }
  }
}

/**
 * Live permanence (DESIGN.md §4/§6): every film this permanence list currently claims that's still
 * `added` or `deletion_queued` is pinned to `kept` immediately — not just when the list is
 * eventually deleted (see `deleteList`, which is now mostly a no-op for films this already caught).
 * Coming from `deletion_queued` also auto-resolves any pending DeletionRequest to `kept`. Runs
 * every sync of a permanence list, which is what self-heals films that were already
 * added/deletion_queued from before this feature existed or before permanence was toggled on for
 * this list. Each film is pinned inside its own transaction with a re-check of current state
 * immediately before writing, matching evaluateForDeletion's race-safety pattern. Never throws — a
 * failure pinning one film is logged and the rest still run.
 */
export async function applyPermanenceClaims(list: ListWithUser): Promise<void> {
  if (!list.permanence) return;

  const claimed = await prisma.listMovie.findMany({
    where: { ...LIVE_CLAIM_WHERE, listId: list.id },
    select: { movieId: true, movie: { select: { state: true } } },
  });
  const toPin = claimed.filter(
    (lm) => lm.movie.state === 'added' || lm.movie.state === 'deletion_queued'
  );
  if (toPin.length === 0) return;

  let pinned = 0;
  for (const lm of toPin) {
    try {
      const didPin = await prisma.$transaction(async (tx) => {
        const current = await tx.movie.findUnique({ where: { id: lm.movieId } });
        if (!current || (current.state !== 'added' && current.state !== 'deletion_queued')) return false;

        if (current.state === 'deletion_queued') {
          await tx.deletionRequest.updateMany({
            where: { movieId: lm.movieId, status: 'pending' },
            data: { status: 'kept', resolvedAt: new Date() },
          });
        }
        await transitionMovie(tx, lm.movieId, 'kept', {
          type: 'kept',
          detail: `list "${list.label}" (permanence) currently claims this film`,
          listId: list.id,
        });
        return true;
      });
      if (didPin) pinned++;
    } catch (e: any) {
      logger.error(`Permanence: failed pinning movie id=${lm.movieId} for list id=${list.id}: ${e?.message ?? e}`);
    }
  }
  if (pinned > 0) {
    logger.info(`List "${list.label}" (permanence): pinned ${pinned} currently-claimed film(s) to kept.`);
  }
}

/**
 * A list being disabled drops every claim it was holding (DESIGN.md §5) -- nothing else reacts to
 * `enabled` flipping false, since a disabled list is simply never synced again (its ListMovie rows
 * would otherwise sit at presentOnList=true forever with no self-correction). Logs a
 * `list_deactivated` claim-drop event for every film it was claiming, then separately runs each
 * through the keeper-rule -- mirroring reconcileList's two-loop shape (log first, evaluate after).
 * Never throws; call it after the list's own `enabled` update has already been persisted.
 */
export async function handleListDisabled(list: ListWithUser): Promise<void> {
  const claimed = await prisma.listMovie.findMany({
    where: { ...LIVE_CLAIM_WHERE, listId: list.id },
    select: { movieId: true },
  });
  if (claimed.length === 0) return;

  for (const lm of claimed) {
    await prisma.$transaction((tx) =>
      logMovieEvent(tx, lm.movieId, {
        type: 'list_deactivated',
        listId: list.id,
        detail: `list "${list.label}" was disabled`,
      })
    );
  }

  for (const lm of claimed) {
    try {
      await evaluateForDeletion(lm.movieId, {
        reason: 'list_deactivated',
        triggeredByListId: list.id,
        requireNotWanted: true,
      });
    } catch (e: any) {
      logger.error(`List-disable: failed evaluating movie id=${lm.movieId}: ${e?.message ?? e}`);
    }
  }
}

/** Approve a pending DeletionRequest: delete from Radarr (and its file), then mark the request
 *  resolved. Deleting the file is standard behavior now — no longer a per-list toggle. */
export async function approveDeletion(requestId: number): Promise<void> {
  const request = await prisma.deletionRequest.findUnique({
    where: { id: requestId },
    include: { movie: true },
  });
  if (!request) throw new Error(`DeletionRequest id=${requestId} not found.`);
  if (request.status !== 'pending') {
    throw new Error(`DeletionRequest id=${requestId} is already ${request.status}.`);
  }
  if (!request.movie.radarrMovieId) {
    throw new Error(`Movie id=${request.movieId} has no radarrMovieId.`);
  }

  const client = await radarrClientFromSettings();
  await deleteMovie(client, request.movie.radarrMovieId);

  await prisma.$transaction(async (tx) => {
    await tx.deletionRequest.update({
      where: { id: requestId },
      data: { status: 'approved', resolvedAt: new Date() },
    });
    await transitionMovie(tx, request.movieId, 'deleted', {
      type: 'deleted',
      detail: 'file deleted',
    });
  });
}

/** Keep a pending DeletionRequest: pin the film (never resurfaces) and mark it resolved. */
export async function keepDeletion(requestId: number): Promise<void> {
  const request = await prisma.deletionRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`DeletionRequest id=${requestId} not found.`);
  if (request.status !== 'pending') {
    throw new Error(`DeletionRequest id=${requestId} is already ${request.status}.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.deletionRequest.update({
      where: { id: requestId },
      data: { status: 'kept', resolvedAt: new Date() },
    });
    await transitionMovie(tx, request.movieId, 'kept', { type: 'kept' });
  });
}

/**
 * Manual escape hatch (DESIGN.md §6): a human releases a `kept` film back into the deletion
 * pipeline when nothing currently claims it — e.g. an old manual Keep no longer reflects anyone's
 * intent, or a permanence list stopped claiming it after the fact. `kept` is otherwise terminal
 * (DESIGN.md §4), so this is a deliberate override, not a keeper-rule outcome — it opens a fresh
 * pending DeletionRequest (reason `manual_reopen`) exactly like any other candidate, including
 * unmonitoring in Radarr. Throws if the film isn't `kept`, or if any enabled list still claims it.
 */
export async function dropKeepStatus(movieId: number): Promise<void> {
  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (!movie) throw new Error(`Movie id=${movieId} not found.`);
  if (movie.state !== 'kept') throw new Error(`Movie id=${movieId} is not kept.`);
  if (await hasClaim(movieId)) throw new Error(`Movie id=${movieId} is still claimed by an enabled list.`);
  if (!movie.radarrMovieId) throw new Error(`Movie id=${movieId} has no radarrMovieId.`);

  const client = await radarrClientFromSettings();
  const radarrMovie = await getMovieById(client, movie.radarrMovieId);
  if (radarrMovie) await setMonitored(client, radarrMovie, false);

  await prisma.$transaction(async (tx) => {
    await transitionMovie(tx, movieId, 'deletion_queued', { type: 'deletion_queued', detail: 'manual_reopen' });
    await tx.deletionRequest.create({
      data: { movieId, reason: 'manual_reopen', triggeredByListId: null, status: 'pending' },
    });
  });
}

/**
 * Admin escape hatch: bring a `pre_existing` film (a Seerr/manual Radarr add that Filmstrip found
 * on a list) under Filmstrip's management. Only reachable from `pre_existing` -- the provenance
 * keystone (DESIGN.md §2) still holds for every other state, so this is the one deliberate crack in
 * it, same spirit as `dropKeepStatus` is for `kept`. After the transition to `added`, runs the exact
 * reconciliation a normal sync would already have done for this one film, right now, instead of
 * waiting for the next sync of whichever list(s) claim it:
 * - zero current claims -> evaluate it for deletion immediately (reason `left_list`), same as a
 *   film that had already left every list it was ever wanted on;
 * - otherwise, for each enabled `removeOnWatch` list currently claiming it, run `reconcileWatched`
 *   for that one list -- if the owner's diary already shows a watch date postdating this list's own
 *   claim (`ListMovie.firstSeenAt`), the film is queued for deletion (reason `watched`)
 *   immediately, rather than sitting managed-but-stale until that list's next sync.
 * An `unwatchedOnly` list's claim needs no special-casing here: its `ListMovie` row already exists
 * with `presentOnList: true` (unwatchedOnly only ever filters *new* adds at scrape time --
 * `src/scheduler/index.ts` -- never an already-tracked claim), so `hasClaim`/`LIVE_CLAIM_WHERE`
 * already count it once the film is `added` -- exactly the "exception" the feature calls for,
 * with no extra code. Don't re-add a watched-state check here later; it would be redundant.
 */
export async function convertToManaged(movieId: number): Promise<{ queued: boolean }> {
  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (!movie) throw new Error(`Movie id=${movieId} not found.`);
  if (movie.state !== 'pre_existing') {
    throw new Error(`Movie id=${movieId} is not pre_existing (state=${movie.state}).`);
  }

  await prisma.$transaction((tx) =>
    transitionMovie(tx, movieId, 'added', {
      type: 'converted_to_managed',
      detail: 'Manually converted from pre_existing by an admin',
    })
  );

  if (!(await hasClaim(movieId))) {
    await evaluateForDeletion(movieId, {
      reason: 'left_list',
      triggeredByListId: null,
      requireNotWanted: true,
    });
  } else {
    const removeOnWatchClaims = await prisma.listMovie.findMany({
      where: { ...LIVE_CLAIM_WHERE, movieId, list: { enabled: true, removeOnWatch: true } },
      include: { list: { include: { user: true } } },
    });
    const checkedListIds = new Set<number>();
    for (const lm of removeOnWatchClaims) {
      if (checkedListIds.has(lm.list.id)) continue;
      checkedListIds.add(lm.list.id);
      try {
        const diaryWatchedDates = await getDiaryWatchedDates(lm.list.userId);
        await reconcileWatched(lm.list, diaryWatchedDates);
      } catch (e: any) {
        logger.error(
          `Convert-to-managed: failed checking removeOnWatch list id=${lm.list.id} for movie id=${movieId}: ${e?.message ?? e}`
        );
      }
    }
  }

  const after = await prisma.movie.findUnique({ where: { id: movieId } });
  return { queued: after?.state === 'deletion_queued' };
}
