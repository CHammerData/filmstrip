import { Router } from 'express';
import prisma from '../../db/client';
import { asyncHandler } from '../http';
import { createRadarrClient, getAllMovies, RadarrMovieResource } from '../../api/radarr';
import logger from '../../util/logger';

/** Live status of a movie in Radarr, joined onto Filmstrip's provenance rows. */
type RadarrStatus = 'downloaded' | 'wanted' | 'unmonitored' | 'not_in_radarr' | 'unknown';

function deriveStatus(radarr: RadarrMovieResource | undefined, radarrConfigured: boolean): RadarrStatus {
  if (!radarrConfigured) return 'unknown';
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

      // Index Radarr's movies by tmdbId for O(1) status lookup. Skipped entirely when unconfigured.
      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      const radarrConfigured = Boolean(settings?.radarrUrl && settings?.radarrApiKey);
      const byTmdbId = new Map<number, RadarrMovieResource>();
      if (radarrConfigured) {
        try {
          const client = createRadarrClient({ url: settings!.radarrUrl!, apiKey: settings!.radarrApiKey! });
          for (const rm of await getAllMovies(client)) byTmdbId.set(rm.tmdbId, rm);
        } catch (e) {
          logger.error('Failed to load Radarr movies for /movies:', e instanceof Error ? e.message : e);
        }
      }

      const rows = movies.map((m) => {
        const radarr = byTmdbId.get(m.tmdbId);
        return {
          id: m.id,
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year,
          addedByFilmstrip: m.addedByFilmstrip,
          pinned: m.pinned,
          radarrStatus: deriveStatus(radarr, radarrConfigured),
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

  return router;
}
