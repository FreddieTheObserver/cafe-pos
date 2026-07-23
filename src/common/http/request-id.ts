import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Express/Node request augmented with the per-request correlation id (set by pino-http). */
export type RequestWithId = IncomingMessage & { id?: string };

/**
 * pino-http `genReqId`: reuse an inbound X-Request-Id (set by a proxy) or mint a
 * UUID, echo it back on the response, and hand it to pino as `req.id`. This makes
 * the log line, the response header, and the error envelope share one id.
 */
export function generateRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const inbound = req.headers['x-request-id'];
  const id = (Array.isArray(inbound) ? inbound[0] : inbound) || randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

/** Reads the correlation id off a request, falling back to "unknown". */
export const getRequestId = (req: unknown): string =>
  (req as RequestWithId | undefined)?.id ?? 'unknown';
