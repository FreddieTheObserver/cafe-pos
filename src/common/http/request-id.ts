import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Express request augmented with the per-request correlation id. */
export type RequestWithId = Request & { id?: string };

/**
 * Assigns a correlation id to every request (honoring an inbound X-Request-Id
 * if a proxy set one) and echoes it back in the response header. The filter puts
 * it in every error body; the logger (Task 5) reuses it so logs and responses
 * share one id.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers['x-request-id'];
  const id = (Array.isArray(inbound) ? inbound[0] : inbound) || randomUUID();
  (req as RequestWithId).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Reads the correlation id off a request, falling back to "unknown". */
export const getRequestId = (req: unknown): string =>
  (req as RequestWithId | undefined)?.id ?? 'unknown';
