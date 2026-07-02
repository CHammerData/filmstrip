import { Request, Response, NextFunction } from 'express';
import { validateSession, SessionWithUser } from '../auth';
import { asyncHandler, HttpError } from './http';

/** Cookie the session token rides in. */
export const SESSION_COOKIE = 'filmstrip_session';

// Make req.session available to route handlers after requireAuth runs.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionWithUser;
    }
  }
}

/** Cookie options for the session token. Secure only in production so http://localhost dev works. */
export function sessionCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeMs,
  };
}

/** Require a valid session; attaches it to req.session or 401s. */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = await validateSession(token);
  if (!session) throw new HttpError(401, 'Authentication required.');
  req.session = session;
  next();
});

/** Require the session to be an admin (Jellyfin IsAdministrator). Assumes requireAuth ran first. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session) throw new HttpError(401, 'Authentication required.');
  if (!req.session.isAdmin) throw new HttpError(403, 'Administrator access required.');
  next();
}
