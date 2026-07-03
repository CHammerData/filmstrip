import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../db/client';
import { asyncHandler, parseBody } from '../http';
import { isHttpUrl } from '../../util/url';

// A connection URL: null or empty clears it; anything else must be an absolute http(s) URL. Rejecting
// a schemeless value here (e.g. "radarr.magi-home.xyz") stops it from silently becoming an "Invalid
// URL" failure the first time the app calls Radarr/Jellyfin.
const connectionUrl = z
  .string()
  .nullable()
  .refine((v) => v === null || v.trim() === '' || isHttpUrl(v.trim()), {
    message: 'must be an absolute URL including http:// or https:// (e.g. http://radarr:7878)',
  });

const patchSchema = z
  .object({
    radarrUrl: connectionUrl,
    radarrApiKey: z.string().nullable(),
    jellyfinUrl: connectionUrl,
    jellyfinApiKey: z.string().nullable(),
    defaultQualityProfile: z.string().nullable(),
    defaultRootFolderId: z.string().nullable(),
    defaultMinimumAvailability: z.enum(['announced', 'inCinemas', 'released']),
    defaultCheckIntervalMin: z.number().int().positive(),
    dryRun: z.boolean(),
  })
  .partial()
  .strict();

/** The Settings singleton (id=1), created blank on first read so the API always has a row. */
async function getOrCreateSettings() {
  const existing = await prisma.settings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  return prisma.settings.create({ data: { id: 1 } });
}

export function settingsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await getOrCreateSettings());
    })
  );

  router.patch(
    '/',
    asyncHandler(async (req, res) => {
      const data = parseBody(patchSchema, req.body);
      await getOrCreateSettings(); // ensure the row exists before update
      const updated = await prisma.settings.update({ where: { id: 1 }, data });
      res.json(updated);
    })
  );

  return router;
}
