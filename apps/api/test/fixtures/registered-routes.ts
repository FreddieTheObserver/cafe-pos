import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Lists the endpoints Express is serving under the versioned prefix.
 *
 * Nest's global-prefix machinery also registers catch-all layers (`/api/v1$`,
 * `/api/v1/{*path}`) bound to every HTTP method; those are plumbing, not
 * endpoints, so paths carrying wildcard or anchor syntax are dropped. What is
 * left is the actual controller surface.
 */
export function registeredApiRoutes(app: NestExpressApplication): string[] {
  const expressApp = app.getHttpAdapter().getInstance() as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  const stack = (expressApp.router ?? expressApp._router)?.stack ?? [];

  const routes = stack.flatMap((layer) => {
    const route = (
      layer as {
        route?: { path?: string; methods?: Record<string, boolean> };
      }
    ).route;
    const path = route?.path;
    if (typeof path !== 'string') return [];
    if (!path.startsWith('/api/v1/')) return [];
    if (path.includes('*') || path.includes('$')) return [];

    return Object.entries(route?.methods ?? {})
      .filter(([method, enabled]) => enabled && method !== '_all')
      .map(([method]) => `${method} ${path}`);
  });

  return [...new Set(routes)];
}
