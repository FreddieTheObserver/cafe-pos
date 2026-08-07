import { RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

export interface AppHardeningOptions {
  /** Browser origins allowed to call the API; empty disables CORS entirely. */
  corsOrigins: string[];
}

/**
 * Caps a single JSON request body. Order payloads are a few KB at most (§3.4),
 * so this is generous while still bounding what an unattended kiosk — or an
 * attacker holding a kiosk token — can push into memory per request.
 *
 * Deliberately not Express's 100 KB default: Phase 4's Stripe webhook needs its
 * own raw-body parser, and an explicit limit here makes that carve-out obvious
 * rather than something inherited by accident.
 */
const JSON_BODY_LIMIT = '64kb';

/** URI versioning (§5.1): the version is visible in logs, curl and dashboards. */
const API_PREFIX = 'api/v1';

/**
 * Methods a configured browser origin may use.
 *
 * Exported so the authz sweep can assert it covers every method the app
 * actually routes. Phase 2 proved that matters: `PUT /items/:id/option-groups`
 * shipped while this list still read GET/POST/PATCH/DELETE, which would have
 * failed preflight for the back office (§2.1) the moment CORS was switched on
 * — and no test would have noticed, because CORS is off by default.
 */
export const CORS_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

/**
 * Platform probes stay off the prefix (§16): orchestrators are configured with
 * fixed paths and must keep working across API versions.
 */
const UNPREFIXED_ROUTES = [
  { path: 'healthz', method: RequestMethod.GET },
  { path: 'readyz', method: RequestMethod.GET },
];

/**
 * Applies every cross-cutting HTTP concern that must hold in production.
 *
 * Lives here rather than inline in `main.ts` so the e2e suite configures its
 * test app through exactly the same code path — otherwise the hardening below
 * would be untested by construction.
 *
 * **Callers must create the app with `{ bodyParser: false, rawBody: true }`.**
 * The first makes the limit below the only JSON parser registered; Nest's
 * default 100 KB parser would otherwise consume the request first and silently
 * win. The second makes `useBodyParser` keep the untouched bytes on
 * `req.rawBody`, which is the only thing the Stripe webhook can verify a
 * signature against — and it must be set at creation, because the parser is
 * built with that behaviour or without it.
 */
export function configureApp(
  app: NestExpressApplication,
  options: AppHardeningOptions,
): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });

  // Removes X-Powered-By and sets the standard defensive headers. The API only
  // ever returns JSON, so the HTML-oriented defaults cost nothing.
  app.use(helmet());

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });

  // No origins configured means same-origin clients only (native kiosk apps
  // are not browsers and need no CORS) — the permissive case is opt-in.
  if (options.corsOrigins.length > 0) {
    app.enableCors({
      origin: options.corsOrigins,
      methods: [...CORS_METHODS],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
      credentials: false,
      maxAge: 600,
    });
  }

  // Fire OnApplicationShutdown hooks (drains the DB pool, quits Redis) on
  // SIGTERM/SIGINT so rolling deploys don't sever in-flight work (§16).
  app.enableShutdownHooks();
}
