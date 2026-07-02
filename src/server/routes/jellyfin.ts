import { Router } from 'express';
import prisma from '../../db/client';
import { asyncHandler } from '../http';
import { createJellyfinClient, getUsers } from '../../api/jellyfin';
import logger from '../../util/logger';

/**
 * Jellyfin account list for the "add a user" picker, so manual users always carry a real
 * jellyfinUserId (no forked duplicate when they later log in). Each candidate is flagged `linked`
 * when a Filmstrip user already owns that Jellyfin id. Degrades to { configured: false } when
 * Jellyfin is unset/unreachable, so the Users page falls back to free-text entry.
 */
export function jellyfinRouter(): Router {
  const router = Router();

  router.get(
    '/users',
    asyncHandler(async (_req, res) => {
      const empty = { configured: false, users: [] };

      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings?.jellyfinUrl || !settings?.jellyfinApiKey) {
        res.json(empty);
        return;
      }

      try {
        const client = createJellyfinClient({ url: settings.jellyfinUrl, apiKey: settings.jellyfinApiKey });
        const jfUsers = await getUsers(client);

        const existing = await prisma.user.findMany({
          where: { jellyfinUserId: { not: null } },
          select: { jellyfinUserId: true },
        });
        const linkedIds = new Set(existing.map((u) => u.jellyfinUserId));

        res.json({
          configured: true,
          users: jfUsers.map((u) => ({ ...u, linked: linkedIds.has(u.id) })),
        });
      } catch (e) {
        logger.error('Failed to load Jellyfin users:', e instanceof Error ? e.message : e);
        res.json(empty);
      }
    })
  );

  return router;
}
