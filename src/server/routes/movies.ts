import { Router } from 'express';
import prisma from '../../db/client';
import { asyncHandler, notFound, parseId } from '../http';
import { createRadarrClient, getAllMovies, RadarrMovieResource } from '../../api/radarr';
import logger from '../../util/logger';

/** Live status of a movie in Radarr, joined onto Filmstrip's provenance rows. */
type RadarrStatus = 'downloaded' | 'wanted' | 'unmonitored' | 'not_in_radarr' | 'unknown';

// `radarrAvailable` means we actually got a movie list back. When Radarr is unconfigured OR
// configured-but-unreachable it's false, and every row is "unknown" rather than "not_in_radarr" --
// otherwise a transient Radarr outage would paint the whole library as missing.
function deriveStatus(radarr: RadarrMovieResource | undefined, radarrAvailable: boolean): RadarrStatus {
  if (!radarrAvailable) return 'unknown';
  if (!radarr) return 'not_in_radarr';
  if (radarr.hasFile) return 'downloaded';
  return radarr.monitored ? 'wanted' : 'unmonitored';
}

/**
 * The Movies provenance view: every film Filmstrip tracks, which list(s)/owner(s) pulled it in, and
 * its current state in Radarr. Radarr is queried once (getAllMovies) and indexed by tmdbId; when
 * Radarr is unconfigured/unreachable each row's status degrades to "unknown" rather than failing.
 */
export function moviesRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const movies = await prisma.movie.findMany({
        include: {
          listMovies: {
            where: { presentOnList: true },
            include: { list: { include: { user: true } } },
          },
        },
        orderBy: { title: 'asc' },
      });

      // Index Radarr's movies by tmdbId for O(1) status lookup. Skipped when unconfigured; if the
      // fetch fails (Radarr down), radarrAvailable stays false so statuses degrade to "unknown".
      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      const radarrConfigured = Boolean(settings?.radarrUrl && settings?.radarrApiKey);
      const byTmdbId = new Map<number, RadarrMovieResource>();
      let radarrAvailable = false;
      if (radarrConfigured) {
        try {
          const client = createRadarrClient({ url: settings!.radarrUrl!, apiKey: settings!.radarrApiKey! });
          for (const rm of await getAllMovies(client)) byTmdbId.set(rm.tmdbId, rm);
          radarrAvailable = true;
        } catch (e) {
          logger.error(`Failed to load Radarr movies for /movies: ${e instanceof Error ? e.message : e}`);
        }
      }

      const rows = movies.map((m) => {
        const radarr = byTmdbId.get(m.tmdbId);
        return {
          id: m.id,
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year,
          state: m.state,
          radarrStatus: deriveStatus(radarr, radarrAvailable),
          radarr: radarr
            ? {
                present: true,
                hasFile: Boolean(radarr.hasFile),
                monitored: Boolean(radarr.monitored),
                sizeOnDisk: Number(radarr.sizeOnDisk ?? 0),
              }
            : null,
          sources: m.listMovies.map((lm) => ({
            listId: lm.listId,
            listLabel: lm.list.label,
            listType: lm.list.listType,
            ownerName: lm.list.user.name,
          })),
        };
      });

      res.json(rows);
    })
  );

  // A film's full chronological history (DESIGN.md §4): every state transition plus every
  // per-list seen/left/restored event, oldest first.
  router.get(
    '/:id/history',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const movie = await prisma.movie.findUnique({ where: { id } });
      if (!movie) throw notFound(`Movie id=${id} not found.`);

      const events = await prisma.movieEvent.findMany({
        where: { movieId: id },
        include: { list: true },
        orderBy: { createdAt: 'asc' },
      });

      res.json({
        movie: {
          id: movie.id,
          tmdbId: movie.tmdbId,
          title: movie.title,
          year: movie.year,
          state: movie.state,
        },
        events: events.map((e) => ({
          id: e.id,
          type: e.type,
          detail: e.detail,
          listLabel: e.list?.label ?? null,
          createdAt: e.createdAt,
        })),
      });
    })
  );

  return router;
}
