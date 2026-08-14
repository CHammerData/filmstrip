import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../db/client';
import { forceReconcileWatched } from '../../scheduler';
import { asyncHandler, parseBody, parseId, notFound, conflict } from '../http';
import logger from '../../util/logger';

// Same rule as /api/me: the username flows into a scrape URL, so reject path-bearing / oversized
// values. null clears it. Kept in sync with src/server/routes/me.ts.
const letterboxdUsername = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z0-9_]+$/, 'Letterboxd usernames use only letters, numbers, and underscores.');

const createSchema = z
  .object({
    name: z.string().min(1),
    tag: z.string().min(1),
    enabled: z.boolean().optional(),
    letterboxdUsername: letterboxdUsername.nullable().optional(),
    jellyfinUserId: z.string().nullable().optional(),
  })
  .strict();

const updateSchema = createSchema.partial();

export function usersRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await prisma.user.findMany({ orderBy: { id: 'asc' } }));
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const user = await prisma.user.findUnique({ where: { id }, include: { lists: true } });
      if (!user) throw notFound(`User id=${id} not found.`);
      res.json(user);
    })
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const data = parseBody(createSchema, req.body);
      try {
        const user = await prisma.user.create({ data });
        res.status(201).json(user);
      } catch (e) {
        throw mapUserError(e, data.tag);
      }
    })
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const data = parseBody(updateSchema, req.body);
      try {
        const user = await prisma.user.update({ where: { id }, data });
        res.json(user);
      } catch (e) {
        if (isNotFound(e)) throw notFound(`User id=${id} not found.`);
        throw mapUserError(e, data.tag);
      }
    })
  );

  // Admin-triggered "check watched now" (Users page): force this user's watched-state cache to
  // refresh immediately, then reconcile every removeOnWatch list they own against it, rather than
  // waiting for the next scheduled refresh tick + that list's own next sync.
  //
  // Accepted-and-detached, not awaited. A full refresh walks the user's whole Letterboxd history --
  // measured at ~6 minutes for a 2,000-film account on its first run -- which no reverse proxy will
  // hold a connection open for (NPM's 60s gateway timeout turned a working refresh into a red error
  // banner). The client polls User.lastWatchedRefreshAt to see it land.
  router.post(
    '/:id/refresh-watched',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) throw notFound(`User id=${id} not found.`);

      res.status(202).json({ status: 'started', userId: id, startedAt: new Date().toISOString() });

      // Detached: nothing is awaiting this, so it must swallow its own failures or it would surface
      // as an unhandled rejection long after the response went out.
      void forceReconcileWatched(id).catch((e) => {
        logger.error(`Background watched refresh for user id=${id} failed: ${e instanceof Error ? e.message : e}`);
      });
    })
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      try {
        await prisma.user.delete({ where: { id } });
        res.status(204).end();
      } catch (e) {
        if (isNotFound(e)) throw notFound(`User id=${id} not found.`);
        throw e;
      }
    })
  );

  return router;
}

function isNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';
}

function mapUserError(e: unknown, tag?: string): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = e.meta?.target;
    const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');
    if (fields.includes('jellyfinUserId')) {
      return conflict('That Jellyfin user is already linked to a Filmstrip user.');
    }
    return conflict(`A user with tag "${tag}" already exists.`);
  }
  return e;
}
