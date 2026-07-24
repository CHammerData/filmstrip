import { Router, Request } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../db/client';
import { detectListType } from '../../scraper';
import { syncListById } from '../../scheduler';
import { deleteList, handleListDisabled } from '../../reconcile';
import { asyncHandler, parseBody, parseId, notFound, conflict, badRequest, HttpError } from '../http';
import logger from '../../util/logger';

// Ownership scoping: admins manage any list; everyone else only the lists they own. Reads
// (GET) stay open; this guards the write/sync paths. Assumes requireAuth populated req.session.
function assertCanManage(req: Request, ownerId: number): void {
  const session = req.session;
  if (!session) throw new HttpError(401, 'Authentication required.');
  if (!session.isAdmin && session.userId !== ownerId) {
    throw new HttpError(403, 'You can only manage lists you own.');
  }
}

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

// permanence is a live "keep everything this list claims, forever" guarantee (DESIGN.md §4-§6) --
// it can't coexist with a toggle that's about conditionally dropping films (unwatchedOnly/
// removeOnWatch). Checked against the *effective* values (patch merged over the existing row, or
// the schema defaults on create), since a partial update only sees the fields it's changing.
function assertPermanenceCompatible(effective: {
  permanence: boolean;
  unwatchedOnly: boolean;
  removeOnWatch: boolean;
}): void {
  if (effective.permanence && (effective.unwatchedOnly || effective.removeOnWatch)) {
    throw new HttpError(
      400,
      'A list cannot have permanence enabled together with unwatchedOnly or removeOnWatch.'
    );
  }
}

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
      // You can only create lists you own (admins may create for anyone).
      assertCanManage(req, userId);
      assertPermanenceCompatible({
        permanence: overrides.permanence ?? false,
        unwatchedOnly: overrides.unwatchedOnly ?? false,
        removeOnWatch: overrides.removeOnWatch ?? false,
      });

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
      const existing = await prisma.list.findUnique({ where: { id }, include: { user: true } });
      if (!existing) throw notFound(`List id=${id} not found.`);
      assertCanManage(req, existing.userId);

      const { url, ...rest } = parseBody(updateSchema, req.body);
      assertPermanenceCompatible({
        permanence: rest.permanence ?? existing.permanence,
        unwatchedOnly: rest.unwatchedOnly ?? existing.unwatchedOnly,
        removeOnWatch: rest.removeOnWatch ?? existing.removeOnWatch,
      });

      // Changing the URL re-detects the list type, so they never drift apart.
      const data: Prisma.ListUpdateInput = { ...rest };
      if (url !== undefined) {
        const listType = detectListType(url);
        if (!listType) throw badRequest(`"${url}" is not a supported Letterboxd list URL.`);
        data.url = url;
        data.listType = listType;
      }

      let list;
      try {
        list = await prisma.list.update({ where: { id }, data });
      } catch (e) {
        if (isNotFound(e)) throw notFound(`List id=${id} not found.`);
        if (isUniqueViolation(e)) throw conflict(`That user already has a list for "${url}".`);
        throw e;
      }

      // A list being disabled drops every claim it was holding -- nothing else reacts to `enabled`
      // flipping false, since a disabled list is simply never synced again (DESIGN.md §5). The
      // disable itself already succeeded above; reconciliation here is best-effort.
      if (existing.enabled && list.enabled === false) {
        try {
          await handleListDisabled({ ...list, user: existing.user });
        } catch (e: any) {
          logger.error(`Failed to reconcile claims for disabled list id=${id}: ${e?.message ?? e}`);
        }
      }

      res.json(list);
    })
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const existing = await prisma.list.findUnique({ where: { id } });
      if (!existing) throw notFound(`List id=${id} not found.`);
      assertCanManage(req, existing.userId);
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
      const existing = await prisma.list.findUnique({ where: { id } });
      if (!existing) throw notFound(`List id=${id} not found.`);
      assertCanManage(req, existing.userId);
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
