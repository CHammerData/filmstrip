import { Router } from 'express';
import prisma from '../../db/client';
import { asyncHandler, parseId, badRequest } from '../http';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function syncRunsRouter(): Router {
  const router = Router();

  // Sync history, newest first. ?listId= filters to one list; ?limit= caps the page (<=200).
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const where = req.query.listId !== undefined ? { listId: parseId(String(req.query.listId), 'listId') } : {};

      let limit = DEFAULT_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit <= 0) throw badRequest('limit must be a positive integer.');
        limit = Math.min(limit, MAX_LIMIT);
      }

      const runs = await prisma.syncRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
      });
      res.json(runs);
    })
  );

  return router;
}
