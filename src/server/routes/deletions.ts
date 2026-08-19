import { Router, Request } from 'express';
import { z } from 'zod';
import prisma from '../../db/client';
import { approveDeletion, keepDeletion, getSoleOwnerUserId } from '../../reconcile';
import { asyncHandler, parseId, notFound, conflict, badRequest, HttpError } from '../http';

const statusSchema = z.enum(['pending', 'approved', 'kept']);

// Ownership scoping (feature request): an admin sees/resolves every request; a non-admin only
// those for films that only their own lists ever added -- getSoleOwnerUserId (src/reconcile/index.ts)
// returns null (ambiguous/multi-owner, or the sole contributing list has since been deleted) when
// that can't be determined, which reads as "admin-only" here.
async function assertCanResolve(req: Request, movieId: number): Promise<void> {
  const session = req.session;
  if (!session) throw new HttpError(401, 'Authentication required.');
  if (session.isAdmin) return;
  const soleOwnerId = await getSoleOwnerUserId(movieId);
  if (soleOwnerId !== session.userId) {
    throw new HttpError(403, 'You can only resolve deletion requests for films only your own lists added.');
  }
}

export function deletionsRouter(): Router {
  const router = Router();

  // The review queue. Defaults to pending; ?status= can widen to approved/kept for history. An
  // admin sees every request; a non-admin only those for films only their own lists ever added.
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

      if (req.session!.isAdmin) {
        res.json(requests);
        return;
      }

      // Batch-resolve sole owners for every movie in this page in one query, rather than N+1
      // calls to getSoleOwnerUserId.
      const movieIds = [...new Set(requests.map((r) => r.movieId))];
      const rows = await prisma.listMovie.findMany({
        where: { movieId: { in: movieIds } },
        select: { movieId: true, list: { select: { userId: true } } },
      });
      const ownersByMovie = new Map<number, Set<number>>();
      for (const row of rows) {
        const owners = ownersByMovie.get(row.movieId) ?? new Set<number>();
        owners.add(row.list.userId);
        ownersByMovie.set(row.movieId, owners);
      }
      const userId = req.session!.userId;
      const mine = requests.filter((r) => {
        const owners = ownersByMovie.get(r.movieId);
        return !!owners && owners.size === 1 && owners.has(userId);
      });
      res.json(mine);
    })
  );

  router.post(
    '/:id/approve',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      await assertCanResolveRequest(req, id);
      await runResolution(() => approveDeletion(id));
      res.json({ id, status: 'approved' });
    })
  );

  router.post(
    '/:id/keep',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      await assertCanResolveRequest(req, id);
      await runResolution(() => keepDeletion(id));
      res.json({ id, status: 'kept' });
    })
  );

  return router;
}

/** Load a request's movieId and enforce ownership scoping before it's resolved. 404s (rather than
 *  403ing on a made-up id) if the request doesn't exist. */
async function assertCanResolveRequest(req: Request, requestId: number): Promise<void> {
  const existing = await prisma.deletionRequest.findUnique({ where: { id: requestId } });
  if (!existing) throw notFound(`DeletionRequest id=${requestId} not found.`);
  await assertCanResolve(req, existing.movieId);
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
