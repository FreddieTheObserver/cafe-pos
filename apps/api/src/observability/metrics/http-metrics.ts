import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Metrics } from './metrics';

// Excluded from the request log for the same reason: they fire constantly.
const UNTIMED_PATHS = new Set(['/healthz', '/readyz']);

/**
 * The route pattern a request matched, or `unmatched`.
 *
 * A wildcard pattern is middleware mounted on every path (nestjs-pino's
 * request logger is), not an endpoint: an unknown path matches it and nothing
 * after it. No endpoint here uses a wildcard, so treating one as unmatched
 * loses nothing, and the authz matrix's route inspection fails if one ever does.
 */
export function routeLabelOf(req: Pick<Request, 'baseUrl' | 'route'>): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  return typeof pattern === 'string' && !pattern.includes('*')
    ? `${req.baseUrl}${pattern}`
    : 'unmatched';
}

export function statusClassOf(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

export function timeHttpRequests(metrics: Metrics): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (UNTIMED_PATHS.has(req.path)) {
      next();
      return;
    }

    const end = metrics.httpRequestDuration.startTimer();
    // Read at finish, not now: the router has not matched a route yet.
    res.once('finish', () => {
      end({
        method: req.method,
        route: routeLabelOf(req),
        status_class: statusClassOf(res.statusCode),
      });
    });
    next();
  };
}
