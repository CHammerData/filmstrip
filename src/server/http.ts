import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, ZodType } from 'zod';

/** An error carrying an HTTP status. Thrown by routes/services; the error middleware maps it. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (message: string) => new HttpError(404, message);
export const badRequest = (message: string) => new HttpError(400, message);
export const conflict = (message: string) => new HttpError(409, message);

/**
 * Wrap an async route handler so a rejected promise reaches Express's error pipeline.
 * Express 5 forwards rejected promises automatically, but wrapping keeps intent explicit
 * and stays correct if the handler is ever used somewhere without that behavior.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Parse a route param as a positive integer id, or throw a 400. */
export function parseId(raw: string, name = 'id'): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`Invalid ${name}: "${raw}" is not a positive integer.`);
  }
  return id;
}

/** Validate a request body against a zod schema, throwing a 400 with field details on failure. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, formatZodError(result.error));
  }
  return result.data;
}

function formatZodError(error: ZodError): string {
  const details = error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return `Validation failed: ${details}`;
}
