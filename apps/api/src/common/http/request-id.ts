import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Express/Node request augmented with the per-request correlation id (set by pino-http). */
export type RequestWithId = IncomingMessage & { id?: string };

/** Long enough for UUIDs and W3C traceparent, short enough to bound log/header growth. */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Inbound ids are attacker-controlled: this header lands in log lines and is
 * echoed back as a response header, so anything outside a conservative token
 * charset (CR/LF especially) is rejected rather than sanitized.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

const isUsable = (value: string): boolean =>
  value.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(value);

/**
 * pino-http `genReqId`: reuse an inbound X-Request-Id (set by a proxy) or mint a
 * UUID, echo it back on the response, and hand it to pino as `req.id`. This makes
 * the log line, the response header, and the error envelope share one id.
 *
 * An inbound id is only trusted when it is a bounded, token-safe string —
 * otherwise we fall back to a generated UUID so a caller cannot forge log
 * records or inject response headers.
 */
export function generateRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const inbound = req.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && isUsable(candidate) ? candidate : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

/** Reads the correlation id off a request, falling back to "unknown". */
export const getRequestId = (req: unknown): string =>
  (req as RequestWithId | undefined)?.id ?? 'unknown';
