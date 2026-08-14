import prisma from '../db/client';
import { LetterboxdMovie } from '../scraper';
import { FilmCache } from '../scraper/resolve';
import logger from '../util/logger';

/**
 * SQLite-backed implementation of the scraper's `FilmCache`.
 *
 * Resolving a Letterboxd link to a tmdbId costs one film-page fetch, and every scrape used to pay
 * that for every film it saw, every run -- ~3,500 requests for a single watched-state refresh, plus
 * a full re-resolve of every film on every list on every sync. A slug always points at the same
 * film, so the mapping is cached permanently with no TTL and no invalidation.
 *
 * Lives outside src/scraper on purpose: the scraper modules take params and read no globals, so the
 * DB stays on this side of the boundary and the scraper only ever sees the injected interface.
 */
export function createFilmCache(): FilmCache {
  return {
    async getMany(slugs: string[]): Promise<Map<string, LetterboxdMovie>> {
      if (slugs.length === 0) return new Map();
      const rows = await prisma.letterboxdFilm.findMany({ where: { slug: { in: slugs } } });
      return new Map(
        rows.map((row) => [
          row.slug,
          {
            id: row.letterboxdId,
            name: row.title,
            imdbId: row.imdbId,
            tmdbId: row.tmdbId,
            publishedYear: row.year,
            slug: row.slug,
          },
        ])
      );
    },

    async putMany(movies: LetterboxdMovie[]): Promise<void> {
      // Only films that actually resolved are worth caching. A film with no TMDB link (a TV entry,
      // or one Letterboxd simply hasn't linked yet) is left out so it gets another chance later --
      // that absence is the one part of the mapping that isn't immutable.
      const cacheable = movies.filter((m) => m.tmdbId);
      if (cacheable.length === 0) return;

      try {
        await prisma.$transaction(
          cacheable.map((m) =>
            prisma.letterboxdFilm.upsert({
              where: { slug: m.slug },
              create: {
                slug: m.slug,
                tmdbId: m.tmdbId!,
                imdbId: m.imdbId ?? null,
                title: m.name,
                year: m.publishedYear ?? null,
                letterboxdId: m.id,
              },
              update: {
                tmdbId: m.tmdbId!,
                imdbId: m.imdbId ?? null,
                title: m.name,
                year: m.publishedYear ?? null,
                letterboxdId: m.id,
              },
            })
          )
        );
      } catch (e) {
        // A cache write failing must never fail the scrape that produced the data -- the films are
        // already in hand, and the only cost of not storing them is fetching them again next time.
        logger.warn(`Could not cache ${cacheable.length} resolved film(s): ${e instanceof Error ? e.message : e}`);
      }
    },
  };
}