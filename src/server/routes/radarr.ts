import { Router } from 'express';
import prisma from '../../db/client';
import { asyncHandler } from '../http';
import {
  createRadarrClient,
  getQualityProfiles,
  getRootFolders,
  getAllTags,
} from '../../api/radarr';
import logger from '../../util/logger';

/**
 * Radarr metadata the GUI needs to populate the list-settings dropdowns (quality profiles, root
 * folders, tags). Deliberately never 500s: if Radarr is unconfigured or unreachable it returns
 * { configured: false, ...empty } so the Add/Edit forms fall back to free-text inputs.
 */
export function radarrRouter(): Router {
  const router = Router();

  router.get(
    '/options',
    asyncHandler(async (_req, res) => {
      const empty = { configured: false, qualityProfiles: [], rootFolders: [], tags: [] };

      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings?.radarrUrl || !settings?.radarrApiKey) {
        res.json(empty);
        return;
      }

      try {
        const client = createRadarrClient({ url: settings.radarrUrl, apiKey: settings.radarrApiKey });
        const [qualityProfiles, rootFolders, tags] = await Promise.all([
          getQualityProfiles(client),
          getRootFolders(client),
          getAllTags(client),
        ]);
        res.json({ configured: true, qualityProfiles, rootFolders, tags });
      } catch (e) {
        logger.error('Failed to load Radarr options:', e instanceof Error ? e.message : e);
        res.json(empty);
      }
    })
  );

  return router;
}
