import { Settings, User } from '@prisma/client';
import { fetchMoviesFromUrl, LetterboxdMovie } from '../scraper';
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
    logger.error(`Error scraping Letterboxd watched films for "${user.letterboxdUsername}":`, e?.message ?? e);
    return new Set();
  }
}

async function getJellyfinWatchedTmdbIdsForUser(user: User, settings: Settings): Promise<Set<number>> {
  if (!user.jellyfinUserId || !settings.jellyfinUrl || !settings.jellyfinApiKey) return new Set();
  const client = createJellyfinClient({ url: settings.jellyfinUrl, apiKey: settings.jellyfinApiKey });
  return getJellyfinWatchedTmdbIds(client, user.jellyfinUserId);
}

/** A user's full watched set (DESIGN.md §7): Letterboxd diary/watched ∪ Jellyfin playback,
 *  as TMDB ids. Either source is silently empty if unconfigured. */
export async function getOwnerWatchedTmdbIds(user: User, settings: Settings): Promise<Set<number>> {
  const [letterboxd, jellyfin] = await Promise.all([
    getLetterboxdWatchedTmdbIds(user),
    getJellyfinWatchedTmdbIdsForUser(user, settings),
  ]);
  return new Set([...letterboxd, ...jellyfin]);
}
