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

/**
 * Applies every cross-cutting HTTP concern that must hold in production.
 *
 * Lives here rather than inline in `main.ts` so the e2e suite configures its
 * test app through exactly the same code path — otherwise the hardening below
 * would be untested by construction.
 *
 * **Callers must create the app with `{ bodyParser: false }`**, so the limit
 * below is the only JSON parser registered; Nest's default 100 KB parser would
 * otherwise consume the request first and silently win.
 */
export function configureApp(
  app: NestExpressApplication,
  options: AppHardeningOptions,
): void {
  // Removes X-Powered-By and sets the standard defensive headers. The API only
  // ever returns JSON, so the HTML-oriented defaults cost nothing.
  app.use(helmet());

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });

  // No origins configured means same-origin clients only (native kiosk apps
  // are not browsers and need no CORS) — the permissive case is opt-in.
  if (options.corsOrigins.length > 0) {
    app.enableCors({
      origin: options.corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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
