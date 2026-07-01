import path from 'path';
import fs from 'fs';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import logger from '../util/logger';
import { HttpError } from './http';
import { requireAuth, requireAdmin } from './auth';
import { authRouter } from './routes/auth';
import { settingsRouter } from './routes/settings';
import { usersRouter } from './routes/users';
import { listsRouter } from './routes/lists';
import { deletionsRouter } from './routes/deletions';
import { syncRunsRouter } from './routes/syncRuns';
import { syncRouter } from './routes/sync';

/**
 * Build the Express app (no listen) so tests can drive it via supertest and src/index.ts can
 * bind a port. All routes live under /api.
 *
 * Auth (M6): a Jellyfin login mints a DB-backed session cookie. Everything except /api/health and
 * POST /api/auth/login requires a session (requireAuth). Connection config, user management, the
 * deletion queue, and global sync are admin-only (requireAdmin); any authenticated user can manage
 * lists and read sync history. Per-user list ownership scoping is a later refinement.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRouter());

  app.use('/api/settings', requireAuth, requireAdmin, settingsRouter());
  app.use('/api/users', requireAuth, requireAdmin, usersRouter());
  app.use('/api/lists', requireAuth, listsRouter());
  app.use('/api/deletions', requireAuth, requireAdmin, deletionsRouter());
  app.use('/api/sync-runs', requireAuth, syncRunsRouter());
  app.use('/api/sync', requireAuth, requireAdmin, syncRouter());

  // Unknown /api route -> 404 JSON (rather than Express's default HTML).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  serveSpa(app);

  app.use(errorHandler);

  return app;
}

/**
 * Serve the built React SPA (web/dist) when it exists: static assets + a catch-all that returns
 * index.html so client-side routes deep-link. No-op when the build is absent (dev uses Vite's own
 * server with an /api proxy; tests only hit /api), so createApp stays usable everywhere.
 */
function serveSpa(app: Express): void {
  // dist/server/app.js -> ../../.. -> repo root; also works under ts-node (src/server/app.ts).
  const webDist = path.resolve(__dirname, '../../web/dist');
  const indexHtml = path.join(webDist, 'index.html');
  if (!fs.existsSync(indexHtml)) return;

  app.use(express.static(webDist));
  // Express 5 / path-to-regexp v8 rejects a bare '*'; use a named catch-all splat.
  app.get('/*splat', (_req, res) => res.sendFile(indexHtml));
  logger.info(`Serving web UI from ${webDist}`);
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
