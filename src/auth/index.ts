import crypto from 'crypto';
import { Session, User } from '@prisma/client';
import prisma from '../db/client';
import { authenticateByName } from '../api/jellyfin';
import { JellyfinAuthError } from '../api/jellyfin.errors';
import { isHttpUrl } from '../util/url';
import logger from '../util/logger';

/** How long a GUI session lives (the "remember me" window). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthResult {
  token: string;
  user: User;
  isAdmin: boolean;
}

/** A validated session joined with its owning user (what the middleware attaches to req). */
export type SessionWithUser = Session & { user: User };

/**
 * Authenticate against Jellyfin, provision/link a Filmstrip User, and open a session.
 * Throws if Jellyfin isn't configured (caller maps to 400) or credentials are rejected
 * (caller maps to 401).
 */
export async function login(username: string, password: string): Promise<AuthResult> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });

  // Bootstrap fallback (gui mode): a fresh deploy has no Settings.jellyfinUrl yet, but login needs a
  // Jellyfin server to authenticate against — and the Settings page that sets it is behind login.
  // JELLYFIN_URL from env breaks that chicken-and-egg for the first sign-in; once an admin saves
  // the URL in Settings, the DB value takes precedence.
  const jellyfinUrl = settings?.jellyfinUrl || process.env.JELLYFIN_URL;
  if (!jellyfinUrl) {
    throw new Error(
      'Jellyfin is not configured. Set jellyfinUrl in Settings (or the JELLYFIN_URL env var) before logging in.'
    );
  }
  // Catch a schemeless/malformed URL here so it reports as a configuration problem, not a rejected
  // password. (A stale DB value or a bad JELLYFIN_URL env can still reach this even after the
  // Settings route validates new saves.)
  if (!isHttpUrl(jellyfinUrl)) {
    throw new JellyfinAuthError(
      'invalid-url',
      'The configured Jellyfin URL is invalid — it must include http:// or https://.',
      `jellyfinUrl="${jellyfinUrl}"`
    );
  }

  const identity = await authenticateByName(jellyfinUrl, username, password);
  const user = await findOrCreateUser(identity.jellyfinUserId, identity.name);

  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({
    data: {
      token,
      userId: user.id,
      isAdmin: identity.isAdmin,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  logger.info(`Login: ${identity.name} (jellyfin=${identity.jellyfinUserId}, admin=${identity.isAdmin}).`);
  return { token, user, isAdmin: identity.isAdmin };
}

/** Look up a session by token; returns it (with user) if present and unexpired, else null.
 *  Expired sessions are deleted on encounter. Touches lastSeenAt on a hit. */
export async function validateSession(token: string): Promise<SessionWithUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  return session;
}

/** End a session. No-op if the token is unknown. */
export async function logout(token: string): Promise<void> {
  if (!token) return;
  await prisma.session.deleteMany({ where: { token } });
}

/** Find the Filmstrip User linked to this Jellyfin id, or auto-provision one. */
async function findOrCreateUser(jellyfinUserId: string, name: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { jellyfinUserId } });
  if (existing) return existing;

  const tag = await deriveUniqueTag(name);
  return prisma.user.create({ data: { name, jellyfinUserId, tag } });
}

/** Turn a display name into a Radarr-safe, unique tag (e.g. "Chris H." -> "chris-h"). */
async function deriveUniqueTag(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';

  let candidate = base;
  for (let n = 2; ; n++) {
    const taken = await prisma.user.findUnique({ where: { tag: candidate } });
    if (!taken) return candidate;
    candidate = `${base}-${n}`;
  }
}
