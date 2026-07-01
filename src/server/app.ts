import express, { Express, Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../util/logger';
import { HttpError } from './http';
import { settingsRouter } from './routes/settings';
import { usersRouter } from './routes/users';
import { listsRouter } from './routes/lists';
import { deletionsRouter } from './routes/deletions';
import { syncRunsRouter } from './routes/syncRuns';
import { syncRouter } from './routes/sync';

/**
 * Build the Express app (no listen) so tests can drive it via supertest and src/index.ts can
 * bind a port. All routes live under /api. Auth is intentionally absent -- it arrives with the
 * GUI (M6, Jellyfin accounts); until then the API assumes a trusted local network.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/settings', settingsRouter());
  app.use('/api/users', usersRouter());
  app.use('/api/lists', listsRouter());
  app.use('/api/deletions', deletionsRouter());
  app.use('/api/sync-runs', syncRunsRouter());
  app.use('/api/sync', syncRouter());

  // Unknown /api route -> 404 JSON (rather than Express's default HTML).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use(errorHandler);

  return app;
}

// Central error middleware: HttpError -> its status; zod parse escapes -> 400; else 500.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid query parameter.' });
    return;
  }
  logger.error('Unhandled API error:', err instanceof Error ? err.message : err);
  res.status(500).json({ error: 'Internal server error.' });
}
