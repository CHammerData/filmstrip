import { Router } from 'express';
import { z } from 'zod';
import { login, logout, SESSION_TTL_MS } from '../../auth';
import { asyncHandler, parseBody, HttpError } from '../http';
import { requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../auth';

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();

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
        // "not configured" -> 400; anything else (bad creds, unreachable) -> 401.
        const message = e instanceof Error ? e.message : 'Login failed.';
        if (/not configured/i.test(message)) throw new HttpError(400, message);
        throw new HttpError(401, 'Invalid Jellyfin credentials.');
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
