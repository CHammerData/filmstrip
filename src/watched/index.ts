import { Settings, User } from '@prisma/client';
import prisma from '../db/client';
import { fetchMoviesFromUrl, LetterboxdMovie } from '../scraper';
import { DiaryScraper, DiaryEntry } from '../scraper/diary';
import { createJellyfinClient, getWatchedTmdbIds as getJellyfinWatchedTmdbIds } from '../api/jellyfin';
import logger from '../util/logger';

/** This user's Letterboxd watched set, scraped from their public /films/ page. Empty (not
 *  thrown) if the username isn't set or the scrape fails -- watched-state is supplementary,
 *  never something that should block a list's Radarr sync. */
async function getLetterboxdWatchedTmdbIds(user: User): Promise<Set<number>> {
  if (!user.letterboxdUsername) return new Set();
  try {
    const movies = await fetchMoviesFromUrl(`https://letterboxd.com/${user.letterboxdUsername}/films/`);
    return new Set(
      movies
        .filter((m: LetterboxdMovie) => m.tmdbId)
        .map((m: LetterboxdMovie) => parseInt(m.tmdbId!))
    );
  } catch (e: any) {
    logger.error(`Error scraping Letterboxd watched films for "${user.letterboxdUsername}": ${e?.message ?? e}`);
    return new Set();
  }
}

/** This user's Letterboxd diary -- the only source with a real per-film watched date. Empty (not
 *  thrown) if the username isn't set or the scrape fails, same as the aggregate scrape above. */
async function getLetterboxdDiaryEntries(user: User): Promise<DiaryEntry[]> {
  if (!user.letterboxdUsername) return [];
  try {
    return await new DiaryScraper(user.letterboxdUsername).getEntries();
  } catch (e: any) {
    logger.error(`Error scraping Letterboxd diary for "${user.letterboxdUsername}": ${e?.message ?? e}`);
    return [];
  }
}

async function getJellyfinWatchedTmdbIdsForUser(user: User, settings: Settings): Promise<Set<number>> {
  if (!user.jellyfinUserId || !settings.jellyfinUrl || !settings.jellyfinApiKey) return new Set();
  const client = createJellyfinClient({ url: settings.jellyfinUrl, apiKey: settings.jellyfinApiKey });
  return getJellyfinWatchedTmdbIds(client, user.jellyfinUserId);
}

/**
 * A user's full watched set (DESIGN.md §7): Letterboxd diary/watched ∪ Jellyfin playback, as TMDB
 * ids. Either source is silently empty if unconfigured.
 *
 * @deprecated live, per-call scrape -- kept only until the scheduler's unwatchedOnly check is
 * rewired onto the cached WatchedFilm table (a following change). New code should read
 * WatchedFilm instead of calling this.
 */
export async function getOwnerWatchedTmdbIds(user: User, settings: Settings): Promise<Set<number>> {
  const [letterboxd, jellyfin] = await Promise.all([
    getLetterboxdWatchedTmdbIds(user),
    getJellyfinWatchedTmdbIdsForUser(user, settings),
  ]);
  return new Set([...letterboxd, ...jellyfin]);
}

/**
 * This user's diary-logged watch dates (DESIGN.md §7) -- only letterboxd_diary rows carry a real
 * date; aggregate/jellyfin rows are presence-only and never trigger removeOnWatch (a
 * watched-but-undiaried film can't be told "just watched" from "watched years ago"). Reads the
 * WatchedFilm cache (refreshed independently on Settings.watchedRefreshIntervalMin), not a live
 * scrape.
 */
export async function getDiaryWatchedDates(userId: number): Promise<Map<number, Date>> {
  const rows = await prisma.watchedFilm.findMany({
    where: { userId, source: 'letterboxd_diary', watchedAt: { not: null } },
    select: { tmdbId: true, watchedAt: true },
  });
  return new Map(rows.map((r) => [r.tmdbId, r.watchedAt!]));
}

/**
 * Refresh one user's cached watched-state (DESIGN.md §7): diary (dated) + aggregate watched-films
 * (presence only) + Jellyfin playback (presence only), upserted into WatchedFilm. A diary date
 * always wins over a presence-only record for the same film -- it's the only reliable "when," and
 * the only thing removeOnWatch is ever allowed to compare against (a watched-but-undiaried film
 * can raise unwatchedOnly's presence check, but never removeOnWatch's date check). A film logged
 * more than once in the diary (a rewatch) keeps its most recent date.
 */
export async function refreshWatchedState(user: User, settings: Settings): Promise<void> {
  const [diaryEntries, aggregateIds, jellyfinIds] = await Promise.all([
    getLetterboxdDiaryEntries(user),
    getLetterboxdWatchedTmdbIds(user),
    getJellyfinWatchedTmdbIdsForUser(user, settings),
  ]);

  const byTmdbId = new Map<number, { watchedAt: Date | null; source: string }>();
  for (const tmdbId of aggregateIds) byTmdbId.set(tmdbId, { watchedAt: null, source: 'letterboxd_aggregate' });
  for (const tmdbId of jellyfinIds) byTmdbId.set(tmdbId, { watchedAt: null, source: 'jellyfin' });
  for (const entry of diaryEntries) {
    const tmdbId = parseInt(entry.tmdbId, 10);
    if (isNaN(tmdbId)) continue;
    const existing = byTmdbId.get(tmdbId);
    if (!existing || !existing.watchedAt || entry.watchedAt > existing.watchedAt) {
      byTmdbId.set(tmdbId, { watchedAt: entry.watchedAt, source: 'letterboxd_diary' });
    }
  }

  // Sequential: SQLite is single-writer (see scheduler's upsert loop for the same reasoning) --
  // a large watched history fanned out with Promise.all would contend for the write lock.
  for (const [tmdbId, { watchedAt, source }] of byTmdbId) {
    await prisma.watchedFilm.upsert({
      where: { userId_tmdbId: { userId: user.id, tmdbId } },
      update: { watchedAt, source },
      create: { userId: user.id, tmdbId, watchedAt, source },
    });
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastWatchedRefreshAt: new Date() } });
  logger.info(`Refreshed watched state for user "${user.name}": ${byTmdbId.size} film(s) known watched.`);
}

/** Enabled users due for a watched-state refresh, per Settings.watchedRefreshIntervalMin. */
function isDue(user: User, intervalMin: number, now: Date): boolean {
  if (!user.lastWatchedRefreshAt) return true;
  const intervalMs = intervalMin * 60 * 1000;
  return now.getTime() - user.lastWatchedRefreshAt.getTime() >= intervalMs;
}

/** Refresh every enabled user whose watched-state is due, per the global interval. Decoupled from
 *  any list's own sync -- runs once per user regardless of how many lists they own. Never throws;
 *  one user's failure is logged and the rest still run. */
export async function refreshDueUsers(): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    logger.warn('No Settings row; skipping watched-state refresh tick.');
    return;
  }
  const now = new Date();
  const users = (await prisma.user.findMany({ where: { enabled: true } })).filter((u) =>
    isDue(u, settings.watchedRefreshIntervalMin, now)
  );
  for (const user of users) {
    try {
      await refreshWatchedState(user, settings);
    } catch (e: any) {
      logger.error(`Watched-state refresh failed for user id=${user.id}: ${e?.message ?? e}`);
    }
  }
}

/** How often (minutes) to check which users are due -- independent of, and much more frequent
 *  than, Settings.watchedRefreshIntervalMin itself (the per-user interval this tick checks
 *  against), the same relationship SCHEDULER_TICK_MINUTES has to a list's own checkIntervalMin. */
export const WATCHED_STATE_TICK_MINUTES = 15;

/** Start the watched-state refresh scheduler. Returns the timer so callers can stop it. */
export function startWatchedStateScheduler(): NodeJS.Timeout {
  const tickMs = WATCHED_STATE_TICK_MINUTES * 60 * 1000;
  logger.info(
    `Starting watched-state scheduler (tick every ${WATCHED_STATE_TICK_MINUTES}m; ` +
      `per-user interval from Settings.watchedRefreshIntervalMin).`
  );
  refreshDueUsers().catch((e: any) => logger.error(`Watched-state scheduler tick failed: ${e?.message ?? e}`));
  return setInterval(() => {
    refreshDueUsers().catch((e: any) => logger.error(`Watched-state scheduler tick failed: ${e?.message ?? e}`));
  }, tickMs);
}
