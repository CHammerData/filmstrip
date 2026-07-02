import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../db/client';
import { asyncHandler, parseBody, parseId, notFound, conflict } from '../http';

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
