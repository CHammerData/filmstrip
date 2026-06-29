import prisma from '../db/client';
import { resolveListConfig, ListWithUser } from '../db/config';
import { fetchMoviesFromUrl, LetterboxdMovie } from '../scraper';
import { createRadarrClient, upsertMovies, AddResult } from '../api/radarr';
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

/** Should a SyncedMovie row be written for this outcome? */
function shouldRecord(status: AddResult['status']): boolean {
  // 'added' and 'skipped' are terminal (in Radarr, or unfixable like no-tmdbId).
  // 'failed' should be retried next run; 'dryRun' makes no real change.
  return status === 'added' || status === 'skipped';
}

/**
 * Sync a single list end-to-end: scrape -> dedup against SyncedMovie -> upsert to
 * Radarr -> record a SyncRun (and SyncedMovie rows, unless dry-run). Never throws;
 * failures are captured on the returned result and the SyncRun row.
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

    const movies = await fetchMoviesFromUrl(config.url, config.take, config.strategy);

    // Dedup: skip entries we've already processed for this list.
    const seen = await prisma.syncedMovie.findMany({
      where: { listId: list.id },
      select: { letterboxdSlug: true },
    });
    const seenSlugs = new Set(seen.map((s) => s.letterboxdSlug));
    const newMovies = movies.filter((m: LetterboxdMovie) => !seenSlugs.has(m.slug));
    const alreadySynced = movies.length - newMovies.length;

    const client = createRadarrClient({ url: config.radarrUrl, apiKey: config.radarrApiKey });
    const summary = await upsertMovies(client, newMovies, {
      qualityProfile: config.qualityProfile,
      rootFolderId: config.rootFolderId,
      minimumAvailability: config.minimumAvailability,
      monitored: config.monitored,
      tags: config.tags,
      dryRun: config.dryRun,
    });

    // Persist dedup rows (skip in dry-run so the next real run still acts on them).
    if (!config.dryRun) {
      const rows = summary.results.filter((r) => shouldRecord(r.status));
      await Promise.all(
        rows.map((r) =>
          prisma.syncedMovie.create({
            data: {
              listId: list.id,
              letterboxdSlug: r.movie.slug,
              title: r.movie.name,
              year: r.movie.publishedYear ?? null,
              tmdbId: r.movie.tmdbId ? parseInt(r.movie.tmdbId) : null,
              addedToRadarr: r.status === 'added',
              radarrMovieId: r.radarrMovieId ?? null,
            },
          })
        )
      );
    }

    const status: SyncResult['status'] = summary.failed > 0 ? 'partial' : 'success';
    const skipped = summary.skipped + alreadySynced;

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        moviesFound: movies.length,
        moviesAdded: summary.added,
        moviesSkipped: skipped,
        moviesFailed: summary.failed,
      },
    });
    await prisma.list.update({ where: { id: list.id }, data: { lastSyncedAt: new Date() } });

    logger.info(
      `List "${config.label}" ${status}: found=${movies.length} added=${summary.added} ` +
        `skipped=${skipped} failed=${summary.failed}`
    );

    return {
      listId: list.id,
      status,
      found: movies.length,
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
  syncDue().catch((e) => logger.error('Scheduler tick failed:', e));
  return setInterval(() => {
    syncDue().catch((e) => logger.error('Scheduler tick failed:', e));
  }, tickMs);
}
