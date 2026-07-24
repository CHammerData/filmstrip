import path from 'path';
import fs from 'fs';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import prisma from '../db/client';
import logger from '../util/logger';
import { versionInfo } from '../util/version';
import { HttpError } from './http';
import { requireAuth, requireAdmin } from './auth';
import { authRouter } from './routes/auth';
import { settingsRouter } from './routes/settings';
import { usersRouter } from './routes/users';
import { listsRouter } from './routes/lists';
import { deletionsRouter } from './routes/deletions';
import { syncRunsRouter } from './routes/syncRuns';
import { syncRouter } from './routes/sync';
import { radarrRouter } from './routes/radarr';
import { moviesRouter } from './routes/movies';
import { jellyfinRouter } from './routes/jellyfin';
import { meRouter } from './routes/me';

/** How the process is running: full web GUI, or headless sync daemon. */
export type RunMode = 'gui' | 'headless';

/**
 * The /api/health handler, shared by both run modes. Reports version + mode + uptime, and does a
 * fast DB liveness probe: a reachable DB -> 200 {status:'ok'}, an unreachable one -> 503
 * {status:'degraded'}. The Dockerfile HEALTHCHECK checks response.ok, so 503 correctly marks the
 * container unhealthy. Never throws (the probe is wrapped), so it needs no asyncHandler.
 */
function healthHandler(mode: RunMode) {
  return async (_req: Request, res: Response): Promise<void> => {
    const info = { ...versionInfo(), mode, uptime: Math.round(process.uptime()) };
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', ...info });
    } catch (e) {
      logger.error(`Health DB probe failed: ${e instanceof Error ? e.message : e}`);
      res.status(503).json({ status: 'degraded', ...info });
    }
  };
}

/**
 * Log each completed request (method, path, status, elapsed) at info level. Skips /api/health so
 * the 30s Docker HEALTHCHECK doesn't flood the log. gui mode only.
 */
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/api/health') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}

/**
 * Build the full web app (no listen) so tests can drive it via supertest and src/index.ts can
 * bind a port. All routes live under /api.
 *
 * Auth (M6): a Jellyfin login mints a DB-backed session cookie. Everything except /api/health and
 * POST /api/auth/login requires a session (requireAuth). Connection config, user management, the
 * deletion queue, and global sync are admin-only (requireAdmin). Lists are ownership-scoped: any
 * authenticated user can read them, but creating/editing/deleting/syncing a list requires being its
 * owner or an admin (enforced in listsRouter). /api/me lets a user set their own Letterboxd username.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestLogger);

  app.get('/api/health', healthHandler('gui'));

  app.use('/api/auth', authRouter());

  app.use('/api/settings', requireAuth, requireAdmin, settingsRouter());
  app.use('/api/me', requireAuth, meRouter());
  app.use('/api/users', requireAuth, requireAdmin, usersRouter());
  app.use('/api/jellyfin', requireAuth, requireAdmin, jellyfinRouter());
  app.use('/api/lists', requireAuth, listsRouter());
  app.use('/api/radarr', requireAuth, radarrRouter());
  app.use('/api/movies', requireAuth, moviesRouter());
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
 * Build the headless app: the sync scheduler runs in-process (started by src/index.ts); this HTTP
 * surface exists only so the Docker HEALTHCHECK has something to hit. It exposes /api/health and
 * nothing else — no SPA, no auth-gated routes. Every other path 404s as JSON.
 */
export function createHeadlessApp(): Express {
  const app = express();
  app.get('/api/health', healthHandler('headless'));
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
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
  logger.error(`Unhandled API error: ${err instanceof Error ? err.message : err}`);
  res.status(500).json({ error: 'Internal server error.' });
}
