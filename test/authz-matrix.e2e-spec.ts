import type { NestExpressApplication } from '@nestjs/platform-express';
import { uuidv7 } from 'uuidv7';
import { CORS_METHODS } from '../src/bootstrap';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import type { PrincipalRole } from '../src/identity/principal';
import { principalRoles } from '../src/identity/principal';
import { IdentityHarness } from './fixtures/identity-fixtures';

/** Every kind of caller the API can see, including one with no credential. */
const ANONYMOUS = 'ANONYMOUS' as const;
type Caller = typeof ANONYMOUS | PrincipalRole;
const CALLERS: Caller[] = [ANONYMOUS, ...principalRoles];

/** A route open to everyone, credential or not (§5.2). */
const PUBLIC = 'PUBLIC' as const;

interface MatrixRow {
  method: 'get' | 'post' | 'patch' | 'put';
  /** The pattern Nest registered, used by the completeness check below. */
  route: string;
  /** A concrete URL; ids need not exist, because 404 is not an authz answer. */
  path: string;
  allow: Caller[] | typeof PUBLIC;
  body?: Record<string, unknown>;
}

const A = 'ADMIN';
const M = 'MANAGER';
const C = 'CASHIER';
const B = 'BARISTA';
const K = 'KIOSK';

/**
 * Bodies are deliberately *invalid* rather than realistic.
 *
 * The sweep asks one question — did the guards let this caller through? — and
 * several of these endpoints answer 401 for reasons that have nothing to do
 * with authorization: a wrong password, an unknown refresh token, a bad pairing
 * code. An empty body makes the first thing past the guards a 422 from the
 * validation pipe, so any 401 or 403 can only have come from the guards. It
 * also keeps the sweep from creating rows as a side effect.
 */
const EMPTY_BODY = {};

/**
 * §6.4 and the §5.2 catalog, transcribed. This table is the contract §10.4
 * calls it: the guards are checked against these rows, and the completeness
 * test below fails if the app grows a route the table does not mention — so
 * "we added an endpoint and forgot the matrix" cannot reach main.
 */
const MATRIX: MatrixRow[] = [
  {
    method: 'post',
    route: '/api/v1/auth/login',
    path: '/api/v1/auth/login',
    allow: PUBLIC,
    body: EMPTY_BODY,
  },
  {
    method: 'post',
    route: '/api/v1/auth/refresh',
    path: '/api/v1/auth/refresh',
    allow: PUBLIC,
    body: EMPTY_BODY,
  },
  {
    // Any staff role; a kiosk has no session to end (§6.2).
    method: 'post',
    route: '/api/v1/auth/logout',
    path: '/api/v1/auth/logout',
    allow: [A, M, C, B],
    body: EMPTY_BODY,
  },
  {
    method: 'get',
    route: '/api/v1/auth/me',
    path: '/api/v1/auth/me',
    allow: [A, M, C, B, K],
  },
  {
    method: 'post',
    route: '/api/v1/users',
    path: '/api/v1/users',
    allow: [A],
    body: EMPTY_BODY,
  },
  {
    method: 'get',
    route: '/api/v1/users',
    path: '/api/v1/users',
    allow: [A, M],
  },
  {
    method: 'patch',
    route: '/api/v1/users/:id',
    path: `/api/v1/users/${uuidv7()}`,
    allow: [A],
    body: EMPTY_BODY,
  },
  {
    method: 'post',
    route: '/api/v1/devices',
    path: '/api/v1/devices',
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    // Code-gated rather than role-gated: the tablet has no credential yet.
    method: 'post',
    route: '/api/v1/devices/activate',
    path: '/api/v1/devices/activate',
    allow: PUBLIC,
    body: EMPTY_BODY,
  },
  {
    method: 'get',
    route: '/api/v1/devices',
    path: '/api/v1/devices',
    allow: [A, M],
  },
  {
    method: 'patch',
    route: '/api/v1/devices/:id',
    path: `/api/v1/devices/${uuidv7()}`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    method: 'post',
    route: '/api/v1/devices/:id/revoke',
    path: `/api/v1/devices/${uuidv7()}/revoke`,
    allow: [A, M],
  },
  {
    method: 'post',
    route: '/api/v1/categories',
    path: '/api/v1/categories',
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    // Management read, not the kiosk one: it returns inactive categories too,
    // which is why a kiosk has no business here. `GET /menu` is its route.
    method: 'get',
    route: '/api/v1/categories',
    path: '/api/v1/categories',
    allow: [A, M],
  },
  {
    method: 'patch',
    route: '/api/v1/categories/:id',
    path: `/api/v1/categories/${uuidv7()}`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    method: 'post',
    route: '/api/v1/items',
    path: '/api/v1/items',
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    // Management read: returns 86'd items too, which is why the kiosk is not
    // on this row. `GET /menu` is its route.
    method: 'get',
    route: '/api/v1/items',
    path: '/api/v1/items',
    allow: [A, M],
  },
  {
    method: 'patch',
    route: '/api/v1/items/:id',
    path: `/api/v1/items/${uuidv7()}`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    // FR-3: *any* staff member may 86 an item — the person who finds the oat
    // milk gone is whoever is at the bar. Still no kiosk: a tablet reads the
    // menu, it does not edit it.
    method: 'patch',
    route: '/api/v1/items/:id/availability',
    path: `/api/v1/items/${uuidv7()}/availability`,
    allow: [A, M, C, B],
    body: EMPTY_BODY,
  },
  {
    // Multipart, but the sweep only asks whether the guards let the caller
    // through — an empty body reaches the handler and fails on the missing
    // file part, which is well past the point this test cares about.
    method: 'post',
    route: '/api/v1/items/:id/image',
    path: `/api/v1/items/${uuidv7()}/image`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    method: 'put',
    route: '/api/v1/items/:id/option-groups',
    path: `/api/v1/items/${uuidv7()}/option-groups`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    method: 'post',
    route: '/api/v1/option-groups',
    path: '/api/v1/option-groups',
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    method: 'get',
    route: '/api/v1/option-groups',
    path: '/api/v1/option-groups',
    allow: [A, M],
  },
  {
    method: 'patch',
    route: '/api/v1/option-groups/:id',
    path: `/api/v1/option-groups/${uuidv7()}`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    method: 'post',
    route: '/api/v1/option-groups/:id/options',
    path: `/api/v1/option-groups/${uuidv7()}/options`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    method: 'patch',
    route: '/api/v1/options/:id',
    path: `/api/v1/options/${uuidv7()}`,
    allow: [A, M],
    body: EMPTY_BODY,
  },
  {
    // FR-3 again, one level down: "no oat milk" is the same call as "no
    // croissants", and the same people need to be able to make it.
    method: 'patch',
    route: '/api/v1/options/:id/availability',
    path: `/api/v1/options/${uuidv7()}/availability`,
    allow: [A, M, C, B],
    body: EMPTY_BODY,
  },
  {
    // The one catalog route a kiosk may call, and the only read it needs
    // (FR-4). Everything else in this phase is back office.
    method: 'get',
    route: '/api/v1/menu',
    path: '/api/v1/menu',
    allow: [A, M, C, B, K],
  },
  {
    /**
     * The kiosk-first API in one row (§3.6): a tablet and a cashier create
     * orders through the same endpoint. BARISTA is absent because taking
     * orders is not their job — they advance ones that already exist.
     */
    method: 'post',
    route: '/api/v1/orders',
    path: '/api/v1/orders',
    allow: [A, M, C, K],
    body: EMPTY_BODY,
  },
  {
    /**
     * Staff only. §5.2 gives a kiosk the detail route for its own order and no
     * list at all — a tablet in a public space has no business holding a
     * queryable history of what the cafe sold today.
     */
    method: 'get',
    route: '/api/v1/orders',
    path: '/api/v1/orders',
    allow: [A, M, C, B],
  },
  {
    // A kiosk may read its own; the scoping that makes "its own" true is a
    // query filter, and `orders-http` is where that is pinned.
    method: 'get',
    route: '/api/v1/orders/:id',
    path: `/api/v1/orders/${uuidv7()}`,
    allow: [A, M, C, B, K],
  },
];

/** The codes the guards refuse with — the only 401/403 this sweep accepts. */
const GUARD_CODES = [
  'AUTH_TOKEN_INVALID',
  'AUTH_TOKEN_EXPIRED',
  'FORBIDDEN_ROLE',
];

/**
 * Lists the endpoints Express is serving under the versioned prefix.
 *
 * Nest's global-prefix machinery also registers catch-all layers (`/api/v1$`,
 * `/api/v1/{*path}`) bound to every HTTP method; those are plumbing, not
 * endpoints, so paths carrying wildcard or anchor syntax are dropped. What is
 * left is the actual controller surface.
 */
function registeredApiRoutes(app: NestExpressApplication): string[] {
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

/**
 * The §14 authz sweep and this phase's exit criterion: every endpoint against
 * every role.
 *
 * Assertions are about the *authorization boundary*, not success. An allowed
 * caller must not be refused by a guard — it may still get 404 for an id that
 * does not exist or 422 for the empty body above, and treating those as
 * failures would test the fixtures instead of the guards. A denied caller must
 * get 403 FORBIDDEN_ROLE, and an anonymous one 401.
 */
describe('AuthZ matrix (e2e)', () => {
  let harness: IdentityHarness;
  const tokens = new Map<Caller, string | undefined>();

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;

  const request = (row: MatrixRow, caller: Caller) => {
    const call = harness.http()[row.method](row.path);
    const token = tokens.get(caller);
    if (token) call.set('Authorization', `Bearer ${token}`);
    return row.body ? call.send(row.body) : call.send();
  };

  const isAllowed = (row: MatrixRow, caller: Caller): boolean =>
    row.allow === PUBLIC || row.allow.includes(caller);

  const allowedCallers = (row: MatrixRow) =>
    CALLERS.filter((caller) => isAllowed(row, caller));
  const deniedCallers = (row: MatrixRow) =>
    CALLERS.filter((caller) => !isAllowed(row, caller));

  beforeAll(async () => {
    harness = await IdentityHarness.boot();

    tokens.set(ANONYMOUS, undefined);
    for (const role of ['ADMIN', 'MANAGER', 'CASHIER', 'BARISTA'] as const) {
      tokens.set(role, await harness.accessTokenFor(role));
    }
    tokens.set('KIOSK', (await harness.createDevice('ACTIVE')).token);
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  // The sweep is far denser than any real client, and §10.2's limits are not
  // what it is asserting; they have their own suite.
  beforeEach(async () => {
    await harness.clearRateLimits();
  });

  describe.each(MATRIX)('$method $route', (row) => {
    it.each(allowedCallers(row))('admits %s', async (caller) => {
      const res = await request(row, caller);

      // Not "succeeds" — "was not turned away by a guard".
      if (res.status === 401 || res.status === 403) {
        expect(GUARD_CODES).not.toContain(problemOf(res).code);
      }
      expect(res.status).not.toBe(403);
    });

    // Public rows deny nobody, and `it.each([])` is an error rather than a
    // no-op, so the block only exists when there is something to refuse.
    const denied = deniedCallers(row);
    if (denied.length > 0) {
      it.each(denied)('refuses %s', async (caller) => {
        const res = await request(row, caller);

        if (caller === ANONYMOUS) {
          // "Who are you" — the client should authenticate and retry.
          expect(res.status).toBe(401);
          expect(problemOf(res).code).toBe('AUTH_TOKEN_INVALID');
        } else {
          // "Not you" — retrying with the same credential is pointless.
          expect(res.status).toBe(403);
          expect(problemOf(res).code).toBe('FORBIDDEN_ROLE');
        }
      });
    }
  });

  /**
   * §10.4: "drift between doc and code fails CI". The rows above are only a
   * contract if they are exhaustive, so a route that exists without a row is a
   * failure — otherwise the sweep quietly stops covering the API as it grows.
   */
  it('covers every route the application exposes', () => {
    const declared = new Set(MATRIX.map((row) => `${row.method} ${row.route}`));

    const undeclared = registeredApiRoutes(harness.app).filter(
      (route) => !declared.has(route),
    );

    expect(undeclared).toEqual([]);
  });

  it('found those routes by inspection, so the check above cannot pass vacuously', () => {
    expect(registeredApiRoutes(harness.app).sort()).toEqual(
      MATRIX.map((row) => `${row.method} ${row.route}`).sort(),
    );
  });

  /**
   * The CORS allowlist has to cover every method the app actually serves.
   *
   * Phase 2 shipped `PUT /items/:id/option-groups` while the list still read
   * GET/POST/PATCH/DELETE. Nothing failed: CORS is off unless `CORS_ORIGINS` is
   * set, so the browser back office (§2.1) would have hit failed preflights on
   * that route only in an environment where it was configured — the deployed
   * one. Route introspection already lives in this file, so the check belongs
   * here rather than in the hardening suite, which boots a probe module and
   * cannot see the real surface.
   */
  it('advertises every method the application routes as CORS-allowed', () => {
    const served = new Set(
      registeredApiRoutes(harness.app).map((route) =>
        route.split(' ')[0].toUpperCase(),
      ),
    );

    const unadvertised = [...served].filter(
      (method) =>
        !CORS_METHODS.includes(method as (typeof CORS_METHODS)[number]),
    );

    expect(unadvertised).toEqual([]);
  });
});
