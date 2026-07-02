import { Router } from 'express';
import prisma from '../../db/client';
import { asyncHandler } from '../http';
import { createJellyfinClient, getUsers } from '../../api/jellyfin';
import logger from '../../util/logger';

/**
 * Jellyfin account list for the "add a user" picker, so manual users always carry a real
 * jellyfinUserId (no forked duplicate when they later log in). Each candidate is flagged `linked`
 * when a Filmstrip user already owns that Jellyfin id.
 *
 * Response distinguishes three states so the UI can react correctly:
 *  - { configured: false, reachable: true }  -> Jellyfin isn't set up; free-text entry is fine.
 *  - { configured: true,  reachable: false } -> set up but unreachable; the UI must NOT fall back
 *    to free-text (that would create the forked duplicate this picker exists to prevent) -- show a
 *    retry instead.
 *  - { configured: true,  reachable: true }  -> normal; `users` is populated.
 */
export function jellyfinRouter(): Router {
  const router = Router();

  router.get(
    '/users',
    asyncHandler(async (_req, res) => {
      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings?.jellyfinUrl || !settings?.jellyfinApiKey) {
        res.json({ configured: false, reachable: true, users: [] });
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
          reachable: true,
          users: jfUsers.map((u) => ({ ...u, linked: linkedIds.has(u.id) })),
        });
      } catch (e) {
        logger.error('Failed to load Jellyfin users:', e instanceof Error ? e.message : e);
        res.json({ configured: true, reachable: false, users: [] });
      }
    })
  );

  return router;
}
