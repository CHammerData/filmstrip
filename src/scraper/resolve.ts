import Bluebird from 'bluebird';
import { LetterboxdMovie } from '.';
import { getMovie } from './movie';
import { SCRAPE_CONCURRENCY } from './http';
import logger from '../util/logger';

/**
 * Resolve a list of Letterboxd film links to movies, tolerating individual failures. A single
 * film page that can't be fetched (after fetchWithRetry's retries) or parsed is logged and skipped
 * rather than aborting the whole list — one flaky request among hundreds must not fail the sync.
 * Runs at SCRAPE_CONCURRENCY.
 */
export async function resolveMoviesTolerant(links: string[]): Promise<LetterboxdMovie[]> {
  const results = await Bluebird.map(
    links,
    async (link): Promise<LetterboxdMovie | null> => {
      try {
        return await getMovie(link);
      } catch (e) {
        logger.warn(`Skipping film ${link}: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    },
    { concurrency: SCRAPE_CONCURRENCY }
  );

  const movies = results.filter((m): m is LetterboxdMovie => m !== null);
  const skipped = links.length - movies.length;
  if (skipped > 0) {
    logger.warn(`Scraped ${movies.length}/${links.length} films; ${skipped} skipped after retries.`);
  }
  return movies;
}
