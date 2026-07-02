import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../db/client';
import { asyncHandler, parseBody } from '../http';

// Self-service endpoint for the logged-in user. Deliberately narrow: a non-admin can set their
// own Letterboxd username (so the "Unwatched only" / "Remove on watch" prompt works for lists
// they own) without granting the admin-only /api/users write surface. Always targets the caller
// — the id comes from the session, never the body.
const updateSchema = z.object({ letterboxdUsername: z.string().nullable() }).strict();

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
