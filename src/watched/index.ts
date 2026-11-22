import { Settings, User } from '@prisma/client';
import prisma from '../db/client';
import { fetchMoviesFromUrl, LetterboxdMovie } from '../scraper';
import { DiaryScraper, DiaryEntry } from '../scraper/diary';
import {
  createJellyfinClient,
  getWatchedMovies as getJellyfinWatchedMovies,
  getWatchedTmdbIds as getJellyfinWatchedTmdbIds,
  JellyfinWatchedMovie,
} from '../api/jellyfin';
import { createFilmCache } from '../films/cache';
import logger from '../util/logger';

/** This user's Letterboxd watched set, scraped from their public /films/ page. Empty (not
 *  thrown) if the username isn't set or the scrape fails -- watched-state is supplementary,
 *  never something that should block a list's Radarr sync. */
async function getLetterboxdWatchedTmdbIds(user: User, settings: Settings): Promise<Set<number>> {
  return (await scrapeLetterboxdWatchedTmdbIds(user, settings)) ?? new Set();
}

/** As above, but null when the scrape fails (or no username is set), so the refresh can tell a
 *  failed scrape from an empty history. */
async function scrapeLetterboxdWatchedTmdbIds(user: User, settings: Settings): Promise<Set<number> | null> {
  if (!user.letterboxdUsername) return null;
  try {
    const movies = await fetchMoviesFromUrl(
      `https://letterboxd.com/${user.letterboxdUsername}/films/`,
      undefined,
      undefined,
      { flaresolverrUrl: settings.flaresolverrUrl, filmCache: createFilmCache() }
    );
    return new Set(
      movies
        .filter((m: LetterboxdMovie) => m.tmdbId)
        .map((m: LetterboxdMovie) => parseInt(m.tmdbId!))
    );
  } catch (e: any) {
    logger.error(`Error scraping Letterboxd watched films for "${user.letterboxdUsername}": ${e?.message ?? e}`);
    return null;
  }
}

/** This user's Letterboxd diary -- the only source with a real per-film watched date. Empty (not
 *  thrown) if the username isn't set or the scrape fails, same as the aggregate scrape above. */
async function getLetterboxdDiaryEntries(user: User, settings: Settings): Promise<DiaryEntry[]> {
  if (!user.letterboxdUsername) return [];
  try {
    return await new DiaryScraper(user.letterboxdUsername, {
      flaresolverrUrl: settings.flaresolverrUrl,
      filmCache: createFilmCache(),
    }).getEntries();
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

/** This user's Jellyfin plays with last-played dates; null if unconfigured or the call failed. */
async function getJellyfinWatchedMoviesForUser(user: User, settings: Settings): Promise<JellyfinWatchedMovie[] | null> {
  if (!user.jellyfinUserId || !settings.jellyfinUrl || !settings.jellyfinApiKey) return null;
  const client = createJellyfinClient({ url: settings.jellyfinUrl, apiKey: settings.jellyfinApiKey });
  return getJellyfinWatchedMovies(client, user.jellyfinUserId);
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
    getLetterboxdWatchedTmdbIds(user, settings),
    getJellyfinWatchedTmdbIdsForUser(user, settings),
  ]);
  return new Set([...letterboxd, ...jellyfin]);
}

/**
 * This user's dated watches (DESIGN.md §7) -- what removeOnWatch compares against a list's
 * firstSeenAt. A row carries a date when it came from the Letterboxd diary, a Jellyfin play, or a
 * Letterboxd watch that a refresh noticed for the first time (see `refreshWatchedState`); undated
 * rows are presence-only and never trigger removeOnWatch. Reads the WatchedFilm cache (refreshed
 * independently on Settings.watchedRefreshIntervalMin), not a live scrape.
 */
export async function getWatchedDates(userId: number): Promise<Map<number, Date>> {
  const rows = await prisma.watchedFilm.findMany({
    where: { userId, watchedAt: { not: null } },
    select: { tmdbId: true, watchedAt: true },
  });
  return new Map(rows.map((r) => [r.tmdbId, r.watchedAt!]));
}

/**
 * More undated watches than this turning up in one refresh reads as a scrape catching up (the
 * first successful /films/ scrape after failures, or a page that was missing last time), not as
 * films the user just watched, so none of them is dated.
 */
export const NEW_WATCH_BURST_LIMIT = 20;

/**
 * Refresh one user's cached watched-state (DESIGN.md §7) from three sources, upserted into
 * WatchedFilm, and date every watch it can -- removeOnWatch only ever acts on a dated watch:
 *
 * - **Letterboxd diary**: the date logged.
 * - **Jellyfin**: the item's last-played date. Watching a film on the server is as good a "just
 *   watched" signal as logging it.
 * - **Letterboxd /films/ (marked watched, no diary entry)**: no date of its own, so a film is dated
 *   *when a refresh first sees it* -- if this user has been refreshed before (otherwise it's their
 *   history, not a new watch) and the refresh didn't turn up more than NEW_WATCH_BURST_LIMIT such
 *   films at once. A film already in the cache keeps whatever it had.
 *
 * The most recent date wins across sources, and a date already cached is never lost to a later
 * refresh that couldn't reach a source. A film logged more than once in the diary (a rewatch) keeps
 * its most recent date.
 *
 * The two Letterboxd-hitting fetches (diary, aggregate) are run one after another, not
 * concurrently. Confirmed live: firing both at once at this account's own profile pages
 * (`/diary/` and `/films/`) got both 403'd within ~350ms of each other, while either one run in
 * isolation (no concurrent request to the same account) succeeds reliably -- two simultaneous
 * requests to the same profile is a pattern a real browser session never produces, and it
 * apparently reads as bot traffic even though a single request doesn't. Jellyfin is a different
 * host entirely, so it still runs concurrently with the Letterboxd fetches -- no shared rate limit
 * to collide with.
 */
export async function refreshWatchedState(user: User, settings: Settings): Promise<void> {
  const jellyfinPromise = getJellyfinWatchedMoviesForUser(user, settings);
  const diaryEntries = await getLetterboxdDiaryEntries(user, settings);
  const aggregateIds = (await scrapeLetterboxdWatchedTmdbIds(user, settings)) ?? new Set<number>();
  const jellyfinMovies = (await jellyfinPromise) ?? [];

  const cached = new Map(
    (
      await prisma.watchedFilm.findMany({
        where: { userId: user.id },
        select: { tmdbId: true, watchedAt: true, source: true },
      })
    ).map((r) => [r.tmdbId, r])
  );

  // Every dated watch per film, latest wins; presence-only sources just mark the film watched.
  const byTmdbId = new Map<number, { watchedAt: Date | null; source: string }>();
  const offer = (tmdbId: number, watchedAt: Date | null, source: string) => {
    const current = byTmdbId.get(tmdbId);
    if (!current || (watchedAt && (!current.watchedAt || watchedAt > current.watchedAt))) {
      byTmdbId.set(tmdbId, { watchedAt, source });
    }
  };
  for (const tmdbId of aggregateIds) offer(tmdbId, null, 'letterboxd_aggregate');
  for (const m of jellyfinMovies) offer(m.tmdbId, m.lastPlayedAt, 'jellyfin');
  for (const entry of diaryEntries) {
    const tmdbId = parseInt(entry.tmdbId, 10);
    if (!isNaN(tmdbId)) offer(tmdbId, entry.watchedAt, 'letterboxd_diary');
  }

  // Undated and never seen before: a new watch, unless this is the user's first refresh or a burst.
  const newUndated = [...byTmdbId].filter(([tmdbId, w]) => !w.watchedAt && !cached.has(tmdbId));
  const dateNewWatches = user.lastWatchedRefreshAt !== null && newUndated.length <= NEW_WATCH_BURST_LIMIT;
  if (user.lastWatchedRefreshAt !== null && !dateNewWatches) {
    logger.warn(
      `Watched-state refresh for user "${user.name}" found ${newUndated.length} newly watched film(s) ` +
        `with no date (more than ${NEW_WATCH_BURST_LIMIT}); treating them as history, not new watches.`
    );
  }
  const now = new Date();
  for (const [tmdbId, w] of newUndated) {
    if (dateNewWatches) byTmdbId.set(tmdbId, { ...w, watchedAt: now });
  }

  // Sequential: SQLite is single-writer (see scheduler's upsert loop for the same reasoning) --
  // a large watched history fanned out with Promise.all would contend for the write lock.
  for (const [tmdbId, fresh] of byTmdbId) {
    const old = cached.get(tmdbId);
    // Keep a cached date this refresh can't beat (a source was unreachable, or it's undated now).
    const { watchedAt, source } =
      old?.watchedAt && (!fresh.watchedAt || old.watchedAt >= fresh.watchedAt) ? old : fresh;
    if (old && old.source === source && old.watchedAt?.getTime() === watchedAt?.getTime()) continue;
    await prisma.watchedFilm.upsert({
      where: { userId_tmdbId: { userId: user.id, tmdbId } },
      update: { watchedAt, source },
      create: { userId: user.id, tmdbId, watchedAt, source },
    });
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastWatchedRefreshAt: now } });
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
