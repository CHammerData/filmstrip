import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../db/client';
import { asyncHandler, parseBody } from '../http';

// Self-service endpoint for the logged-in user. Deliberately narrow: a non-admin can set their
// own Letterboxd username (so the "Unwatched only" / "Remove on watch" prompt works for lists
// they own) without granting the admin-only /api/users write surface. Always targets the caller
// — the id comes from the session, never the body.
// Validate the username: it flows into a scrape URL (letterboxd.com/<username>/films/), so reject
// path-bearing, whitespace, or oversized values. null clears it. Shared shape with users.ts.
const updateSchema = z
  .object({
    letterboxdUsername: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[A-Za-z0-9_]+$/, 'Letterboxd usernames use only letters, numbers, and underscores.')
      .nullable(),
  })
  .strict();

export function meRouter(): Router {
  const router = Router();

  router.patch(
    '/',
    asyncHandler(async (req, res) => {
      const { letterboxdUsername } = parseBody(updateSchema, req.body);
      const user = await prisma.user.update({
        where: { id: req.session!.userId },
        data: { letterboxdUsername },
      });
      res.json(user);
    })
  );

  return router;
}
