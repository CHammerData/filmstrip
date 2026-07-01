import { Router } from 'express';
import { syncAll, syncDue } from '../../scheduler';
import { asyncHandler } from '../http';

export function syncRouter(): Router {
  const router = Router();

  // Kick every enabled list now. ?due=true honors each list's interval (like a scheduler tick);
  // otherwise all enabled lists are synced regardless of schedule. Runs synchronously and returns
  // the per-list SyncResults -- fine at CLI/small scale; a job queue can come later if needed.
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const due = req.query.due === 'true';
      const results = due ? await syncDue() : await syncAll();
      res.json(results);
    })
  );

  return router;
}
