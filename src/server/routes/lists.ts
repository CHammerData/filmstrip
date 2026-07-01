import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../db/client';
import { detectListType } from '../../scraper';
import { syncListById } from '../../scheduler';
import { deleteList } from '../../reconcile';
import { asyncHandler, parseBody, parseId, notFound, conflict, badRequest, HttpError } from '../http';

// Per-list overrides + behavior toggles. userId/url are only settable on create; listType is
// always derived from the URL, never client-supplied.
const overrideSchema = z.object({
  label: z.string().min(1),
  enabled: z.boolean(),
  qualityProfile: z.string().nullable(),
  rootFolderId: z.string().nullable(),
  minimumAvailability: z.enum(['announced', 'inCinemas', 'released']).nullable(),
  monitored: z.boolean(),
  extraTags: z.string().nullable(),
  takeAmount: z.number().int().positive().nullable(),
  takeStrategy: z.enum(['oldest', 'newest']).nullable(),
  checkIntervalMin: z.number().int().positive().nullable(),
  deleteFiles: z.boolean(),
  permanence: z.boolean(),
  unwatchedOnly: z.boolean(),
  removeOnWatch: z.boolean(),
  makeCollection: z.boolean(),
  collectionNameOverride: z.string().nullable(),
});

const createSchema = overrideSchema
  .partial()
  .extend({ userId: z.number().int().positive(), url: z.string().url() })
  .strict();

const updateSchema = overrideSchema.partial().extend({ url: z.string().url().optional() }).strict();

export function listsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await prisma.list.findMany({ include: { user: true }, orderBy: { id: 'asc' } }));
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const list = await prisma.list.findUnique({ where: { id }, include: { user: true } });
      if (!list) throw notFound(`List id=${id} not found.`);
      res.json(list);
    })
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const { userId, url, label, ...overrides } = parseBody(createSchema, req.body);

      const listType = detectListType(url);
      if (!listType) throw badRequest(`"${url}" is not a supported Letterboxd list URL.`);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw badRequest(`User id=${userId} does not exist.`);

      try {
        const list = await prisma.list.create({
          data: {
            userId,
            url,
            listType,
            label: label ?? `${user.name}'s ${listType}`,
            ...overrides,
          },
        });
        res.status(201).json(list);
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict(`User id=${userId} already has a list for "${url}".`);
        throw e;
      }
    })
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const { url, ...rest } = parseBody(updateSchema, req.body);

      // Changing the URL re-detects the list type, so they never drift apart.
      const data: Prisma.ListUpdateInput = { ...rest };
      if (url !== undefined) {
        const listType = detectListType(url);
        if (!listType) throw badRequest(`"${url}" is not a supported Letterboxd list URL.`);
        data.url = url;
        data.listType = listType;
      }

      try {
        const list = await prisma.list.update({ where: { id }, data });
        res.json(list);
      } catch (e) {
        if (isNotFound(e)) throw notFound(`List id=${id} not found.`);
        if (isUniqueViolation(e)) throw conflict(`That user already has a list for "${url}".`);
        throw e;
      }
    })
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      // deleteList removes the list AND runs its films through the keeper-rule (pin if the
      // list's permanence is on, else queue them for deletion review). See reconcile/deleteList.
      try {
        await deleteList(id);
        res.status(204).end();
      } catch (e) {
        if (e instanceof Error && /not found/i.test(e.message) && !(e instanceof HttpError)) {
          throw notFound(`List id=${id} not found.`);
        }
        throw e;
      }
    })
  );

  // Manual "sync now" for one list. Runs synchronously and returns the SyncResult.
  router.post(
    '/:id/sync',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      try {
        const result = await syncListById(id);
        res.json(result);
      } catch (e) {
        // syncListById throws a plain Error when the list is missing/disabled.
        if (e instanceof Error && !(e instanceof HttpError)) throw badRequest(e.message);
        throw e;
      }
    })
  );

  return router;
}

function isNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
