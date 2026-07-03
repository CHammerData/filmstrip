import { Router } from 'express';
import { z } from 'zod';
import { login, logout, SESSION_TTL_MS } from '../../auth';
import { JellyfinAuthError, jellyfinAuthErrorStatus } from '../../api/jellyfin.errors';
import { asyncHandler, parseBody, HttpError } from '../http';
import { requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../auth';
import logger from '../../util/logger';

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();

/**
 * Map a login failure to an honest HTTP status and log the real cause. Previously every failure was
 * reported as "Invalid Jellyfin credentials", which hid a wrong/unreachable URL behind a fake
 * password error and logged nothing. Now: JellyfinAuthError carries the real kind; "not configured"
 * is a 400; anything unexpected is a logged 500.
 */
function toLoginHttpError(e: unknown): HttpError {
  if (e instanceof JellyfinAuthError) {
    const status = jellyfinAuthErrorStatus[e.kind];
    const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
    const line = `Login failed [${e.kind}]: ${e.message}${e.detail ? ` {${e.detail}}` : ''}${cause}`;
    if (status >= 500) logger.error(line);
    else logger.warn(line);
    return new HttpError(status, e.message);
  }

  const message = e instanceof Error ? e.message : 'Login failed.';
  if (/not configured/i.test(message)) {
    logger.warn(`Login failed: ${message}`);
    return new HttpError(400, message);
  }

  logger.error(`Login failed (unexpected): ${message}`);
  return new HttpError(500, 'Login failed.');
}

export function authRouter(): Router {
  const router = Router();

  // Public: exchange Jellyfin credentials for a session cookie.
  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const { username, password } = parseBody(loginSchema, req.body);
      let result;
      try {
        result = await login(username, password);
      } catch (e) {
        throw toLoginHttpError(e);
      }
      res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions(SESSION_TTL_MS));
      res.json({ user: result.user, isAdmin: result.isAdmin });
    })
  );

  // The rest require a valid session.
  router.post(
    '/logout',
    requireAuth,
    asyncHandler(async (req, res) => {
      await logout(req.cookies?.[SESSION_COOKIE]);
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions(0));
      res.status(204).end();
    })
  );

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({ user: req.session!.user, isAdmin: req.session!.isAdmin });
    })
  );

  return router;
}
