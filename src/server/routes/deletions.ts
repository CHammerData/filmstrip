import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../db/client';
import { approveDeletion, keepDeletion } from '../../reconcile';
import { asyncHandler, parseId, notFound, conflict, badRequest, HttpError } from '../http';

const statusSchema = z.enum(['pending', 'approved', 'kept']);

export function deletionsRouter(): Router {
  const router = Router();

  // The review queue. Defaults to pending; ?status= can widen to approved/kept for history.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const raw = req.query.status;
      const status = raw === undefined ? 'pending' : statusSchema.parse(raw);
      const requests = await prisma.deletionRequest.findMany({
        where: { status },
        include: { movie: true, triggeredByList: true },
        orderBy: { createdAt: 'asc' },
      });
      res.json(requests);
    })
  );

  router.post(
    '/:id/approve',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      await runResolution(() => approveDeletion(id));
      res.json({ id, status: 'approved' });
    })
  );

  router.post(
    '/:id/keep',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      await runResolution(() => keepDeletion(id));
      res.json({ id, status: 'kept' });
    })
  );

  return router;
}

/**
 * approveDeletion/keepDeletion throw plain Errors; map their messages onto HTTP statuses:
 * "not found" -> 404, "already <status>" -> 409, anything else (e.g. no radarrMovieId) -> 400.
 */
async function runResolution(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || e instanceof HttpError) throw e;
    if (/not found/i.test(e.message)) throw notFound(e.message);
    if (/already/i.test(e.message)) throw conflict(e.message);
    throw badRequest(e.message);
  }
}
