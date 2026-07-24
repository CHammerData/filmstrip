import prisma from '../db/client';
import { resolveListConfig, ListWithUser } from '../db/config';
import { fetchMoviesFromUrl, LetterboxdMovie } from '../scraper';
import { createRadarrClient, upsertMovies } from '../api/radarr';
import { reconcileList, reconcileWatched } from '../reconcile';
import { getOwnerWatchedTmdbIds } from '../watched';
import { syncCollection } from '../collections';
import { transitionMovie, logMovieEvent } from '../movieState';
import logger from '../util/logger';

export interface SyncResult {
  listId: number;
  status: 'success' | 'partial' | 'failed';
  found: number;
  added: number;
  skipped: number;
  failed: number;
  error?: string;
  dryRun: boolean;
}

/**
 * Sync a single list end-to-end: scrape -> dedup against ListMovie -> ensure each attempted
 * movie has a Movie/ListMovie row at state 'wanted' -> upsert to Radarr -> transition each to its
 * outcome -> record a SyncRun. Never throws; failures are captured on the returned result and the
 * SyncRun row.
 */
export async function syncList(list: ListWithUser): Promise<SyncResult> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    throw new Error('Settings row (id=1) is missing. Seed Settings before syncing.');
  }

  const run = await prisma.syncRun.create({
    data: { listId: list.id, status: 'running', dryRun: settings.dryRun },
  });

  try {
    const config = resolveListConfig(list, settings);
    logger.info(`Syncing list "${config.label}" (${config.url})${config.dryRun ? ' [DRY RUN]' : ''}`);

    const scraped = await fetchMoviesFromUrl(config.url, config.take, config.strategy);

    // Watched-state (DESIGN.md §7) is only fetched if a toggle actually needs it — it costs a
    // full Letterboxd/Jellyfin watched-history read. A failure here degrades to "nothing
    // watched" rather than failing the sync; it's supplementary to the core Radarr push.
    let watchedTmdbIds = new Set<number>();
    if (config.unwatchedOnly || config.removeOnWatch) {
      try {
        watchedTmdbIds = await getOwnerWatchedTmdbIds(list.user, settings);
      } catch (e: any) {
        logger.error(`Failed to resolve watched state for list id=${list.id}: ${e?.message ?? e}`);
      }
    }

    // unwatchedOnly filters what we attempt to add; it does NOT affect currentTmdbIds below,
    // since whether a film is still actually on the Letterboxd list is a separate question
    // from whether this list wants to (re-)add it right now.
    const movies = config.unwatchedOnly
      ? scraped.filter((m: LetterboxdMovie) => !m.tmdbId || !watchedTmdbIds.has(parseInt(m.tmdbId)))
      : scraped;
    const unwatchedExcluded = scraped.length - movies.length;

    // Dedup: skip movies already resolved for this list (by tmdbId) -- added/pre_existing/
    // deletion_queued/deleted/kept. A movie still 'wanted' (a previous add attempt failed) is
    // retried every sync until it resolves. Movies without a tmdbId can't be identified across
    // runs, so they're always retried — cheap, since upsertMovies short-circuits them without
    // calling Radarr.
    const seen = await prisma.listMovie.findMany({
      where: { listId: list.id },
      select: { movie: { select: { tmdbId: true, state: true } } },
    });
    const resolvedTmdbIds = new Set(
      seen.filter((s) => s.movie.state !== 'wanted').map((s) => s.movie.tmdbId)
    );
    const newMovies = movies.filter(
      (m: LetterboxdMovie) => !m.tmdbId || !resolvedTmdbIds.has(parseInt(m.tmdbId))
    );
    const alreadySynced = movies.length - newMovies.length;

    // Ensure every movie about to be attempted has a Movie/ListMovie row at state 'wanted' before
    // touching Radarr — this is what makes a failed add finally visible (previously a 'failed'
    // outcome was never persisted at all, silently retried forever with zero trace) and it's what
    // lets the dedup above naturally retry a still-'wanted' movie next sync. Skipped in dry-run so
    // nothing is persisted. Sequential: SQLite is single-writer, so a Promise.all fan-out here made
    // a large list (e.g. a ~79-film watchlist -> ~158 concurrent writes) contend for the write lock
    // until Prisma gave up with "Socket timeout".
    if (!config.dryRun) {
      for (const m of newMovies) {
        if (!m.tmdbId) continue;
        const tmdbId = parseInt(m.tmdbId);
        await prisma.$transaction(async (tx) => {
          const movie = await tx.movie.upsert({
            where: { tmdbId },
            update: {},
            create: { tmdbId, title: m.name, year: m.publishedYear ?? null },
          });
          const existingListMovie = await tx.listMovie.findUnique({
            where: { listId_movieId: { listId: list.id, movieId: movie.id } },
          });
          if (!existingListMovie) {
            await logMovieEvent(tx, movie.id, { type: 'seen_on_list', listId: list.id });
          }
          await tx.listMovie.upsert({
            where: { listId_movieId: { listId: list.id, movieId: movie.id } },
            update: { presentOnList: true, lastSeenAt: new Date() },
            create: { listId: list.id, movieId: movie.id, status: 'pending' },
          });
        });
      }
    }

    const client = createRadarrClient({ url: config.radarrUrl, apiKey: config.radarrApiKey });
    const summary = await upsertMovies(client, newMovies, {
      qualityProfile: config.qualityProfile,
      rootFolderId: config.rootFolderId,
      minimumAvailability: config.minimumAvailability,
      monitored: config.monitored,
      tags: config.tags,
      dryRun: config.dryRun,
    });

    if (!config.dryRun) {
      // Transition each attempted movie to its outcome. Movies without a tmdbId were never given
      // a row above and have no stable identity, so they're skipped here too. Only transition the
      // overall Movie state (vs. just this list's ListMovie.status) when it's still 'wanted' --
      // if another list already resolved this same movie first, its state is left alone here,
      // matching how ListMovie is a per-list fact but Movie.state is shared across lists.
      for (const r of summary.results) {
        if (!r.movie.tmdbId) continue;
        const tmdbId = parseInt(r.movie.tmdbId);
        const movie = await prisma.movie.findUnique({ where: { tmdbId } });
        if (!movie) continue;
        await prisma.$transaction(async (tx) => {
          await tx.listMovie.update({
            where: { listId_movieId: { listId: list.id, movieId: movie.id } },
            data: { status: r.status, lastSeenAt: new Date() },
          });
          if (r.status === 'added') {
            if (r.radarrMovieId) {
              await tx.movie.update({ where: { id: movie.id }, data: { radarrMovieId: r.radarrMovieId } });
            }
            if (movie.state === 'wanted') {
              await transitionMovie(tx, movie.id, 'added', { type: 'added_to_radarr' });
            }
          } else if (r.status === 'skipped') {
            if (movie.state === 'wanted') {
              await transitionMovie(tx, movie.id, 'pre_existing', { type: 'already_in_radarr' });
            }
          } else if (r.status === 'failed') {
            await logMovieEvent(tx, movie.id, { type: 'radarr_add_failed', detail: r.reason });
          }
        });
      }

      // Reconcile: anything that fell off this list since the last sync runs through the
      // keeper-rule (DESIGN.md §5). Based on the raw scrape, not the unwatchedOnly-filtered
      // set — leaving the list and being filtered out by unwatchedOnly are different things.
      // Never blocks the sync result on failure.
      const currentTmdbIds = new Set(
        scraped.filter((m: LetterboxdMovie) => m.tmdbId).map((m: LetterboxdMovie) => parseInt(m.tmdbId!))
      );
      try {
        await reconcileList(list, currentTmdbIds);
      } catch (e: any) {
        logger.error(`Reconcile failed for list id=${list.id}: ${e?.message ?? e}`);
      }

      // removeOnWatch: queue review for anything still on this list the owner has now watched.
      if (config.removeOnWatch && watchedTmdbIds.size > 0) {
        try {
          await reconcileWatched(list, watchedTmdbIds);
        } catch (e: any) {
          logger.error(`Reconcile (watched) failed for list id=${list.id}: ${e?.message ?? e}`);
        }
      }

      // makeCollection: mirror this list's current films into a Jellyfin collection.
      if (config.makeCollection) {
        try {
          await syncCollection(list, config.collectionName);
        } catch (e: any) {
          logger.error(`Collection sync failed for list id=${list.id}: ${e?.message ?? e}`);
        }
      }
    }

    const status: SyncResult['status'] = summary.failed > 0 ? 'partial' : 'success';
    const skipped = summary.skipped + alreadySynced + unwatchedExcluded;

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        moviesFound: scraped.length,
        moviesAdded: summary.added,
        moviesSkipped: skipped,
        moviesFailed: summary.failed,
      },
    });
    await prisma.list.update({ where: { id: list.id }, data: { lastSyncedAt: new Date() } });

    logger.info(
      `List "${config.label}" ${status}: found=${scraped.length} added=${summary.added} ` +
        `skipped=${skipped} failed=${summary.failed}`
    );

    return {
      listId: list.id,
      status,
      found: scraped.length,
      added: summary.added,
      skipped,
      failed: summary.failed,
      dryRun: config.dryRun,
    };
  } catch (e: any) {
    const message = e?.message ?? 'unknown error';
    logger.error(`Sync failed for list id=${list.id}: ${message}`);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: 'failed', finishedAt: new Date(), error: message },
    });
    // Advance lastSyncedAt so a broken list isn't retried every tick.
    await prisma.list.update({ where: { id: list.id }, data: { lastSyncedAt: new Date() } });
    return {
      listId: list.id,
      status: 'failed',
      found: 0,
      added: 0,
      skipped: 0,
      failed: 0,
      error: message,
      dryRun: settings.dryRun,
    };
  }
}

/** Load an enabled list (with enabled owner) by id, or null. */
async function loadSyncableList(listId: number): Promise<ListWithUser | null> {
  const list = await prisma.list.findUnique({ where: { id: listId }, include: { user: true } });
  if (!list || !list.enabled || !list.user.enabled) return null;
  return list;
}

/** Sync one list by id (used by the "sync now" CLI/API). */
export async function syncListById(listId: number): Promise<SyncResult> {
  const list = await loadSyncableList(listId);
  if (!list) {
    throw new Error(`List id=${listId} not found, disabled, or owner disabled.`);
  }
  return syncList(list);
}

/** All enabled lists owned by enabled users. */
async function loadEnabledLists(): Promise<ListWithUser[]> {
  return prisma.list.findMany({
    where: { enabled: true, user: { enabled: true } },
    include: { user: true },
  });
}

/** Is a list due for sync, given its effective interval and last run time? */
function isDue(list: ListWithUser, defaultIntervalMin: number, now: Date): boolean {
  if (!list.lastSyncedAt) return true;
  const intervalMs = (list.checkIntervalMin ?? defaultIntervalMin) * 60 * 1000;
  return now.getTime() - list.lastSyncedAt.getTime() >= intervalMs;
}

/** Sync every enabled list immediately, regardless of schedule. */
export async function syncAll(): Promise<SyncResult[]> {
  const lists = await loadEnabledLists();
  const results: SyncResult[] = [];
  for (const list of lists) {
    results.push(await syncList(list));
  }
  return results;
}

/** Sync only the enabled lists whose interval has elapsed. */
export async function syncDue(): Promise<SyncResult[]> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    logger.warn('No Settings row; skipping scheduler tick.');
    return [];
  }
  const now = new Date();
  const lists = (await loadEnabledLists()).filter((l) =>
    isDue(l, settings.defaultCheckIntervalMin, now)
  );
  const results: SyncResult[] = [];
  for (const list of lists) {
    results.push(await syncList(list));
  }
  return results;
}

/** Default scheduler tick: how often we check for due lists (minutes). */
export const SCHEDULER_TICK_MINUTES = 1;

/**
 * Start the DB-driven scheduler: a periodic tick that syncs any list whose
 * per-list interval has elapsed. Returns the timer so callers can stop it.
 */
export function startScheduler(): NodeJS.Timeout {
  const tickMs = SCHEDULER_TICK_MINUTES * 60 * 1000;
  logger.info(`Starting scheduler (tick every ${SCHEDULER_TICK_MINUTES}m; per-list intervals honored).`);

  // Fire once on boot, then on the tick.
  syncDue().catch((e) => logger.error(`Scheduler tick failed: ${e?.message ?? e}`));
  return setInterval(() => {
    syncDue().catch((e) => logger.error(`Scheduler tick failed: ${e?.message ?? e}`));
  }, tickMs);
}
