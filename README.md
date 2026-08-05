# CafePOS

Backend for a single-location cafe point-of-sale system in which **self-order kiosks are first-class clients**. Customers order and pay at unattended kiosks, staff work the same order pipeline from a counter POS, baristas fulfil from a Kitchen Display System (KDS), and the owner gets sales reporting and end-of-day reconciliation.

Because the kiosk is unattended, the backend has to be the adult in the room: prices are computed server-side, payment state follows the gateway webhook rather than the client, and money-mutating requests are idempotent.

**[`DESIGN.md`](./DESIGN.md) is the specification.** It carries the domain model, the full API catalog, the authorization matrix, the database design, and the reasoning behind every non-obvious choice. This README only covers how to run the thing; when the two disagree, `DESIGN.md` wins.

## Stack

| | |
|---|---|
| Runtime | Node.js 22, TypeScript, NestJS 11 (modular monolith) |
| Database | PostgreSQL 16 with Drizzle ORM; migrations via `drizzle-kit` |
| Cache / pub-sub | Redis 7 |
| Object storage | S3-compatible (MinIO locally), for item images |
| Validation | Zod — for environment config and request bodies |
| Image processing | sharp — every upload is decoded and re-encoded to WebP |
| Logging | pino via `nestjs-pino`, JSON in production |
| Tests | Jest (unit) + Jest/supertest against real Postgres, Redis and MinIO (integration) |
| Package manager | pnpm |

## Prerequisites

- Node.js 22 (the version CI builds against)
- pnpm 10
- Docker with Compose v2, for Postgres, Redis and MinIO

## First-time setup

From a fresh clone:

```bash
cp .env.example .env      # defaults already match docker-compose.yml
docker compose up -d      # Postgres on 5433, Redis on 6379, MinIO on 9000/9001
pnpm install
pnpm db:migrate           # applies drizzle/*.sql to the running database
pnpm db:seed              # staff accounts and a small menu, for local use only
pnpm start:dev
```

Then confirm the process is alive and its dependencies are reachable:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

Both should return `200`. If `/readyz` returns `503`, the body names the failing dependency — see [Health endpoints](#health-endpoints).

> **Postgres is published on host port `5433`, not `5432`.** A native PostgreSQL install commonly already owns 5432 on a developer machine, and a silent connection to the wrong server is a miserable way to lose an afternoon. `.env.example` therefore points at `5433`. CI runs on a runner with no native Postgres, so the workflow uses `5432` — that difference between `.env.example` and `.github/workflows/ci.yml` is deliberate, not drift.

> **MinIO stands in for S3.** The API talks to it through the same S3-compatible client it uses in production, so only the endpoint and credentials differ between environments. `S3_AUTO_CREATE_BUCKET=true` in `.env.example` lets the app create the bucket (and mark it publicly readable) at boot, which is why local setup needs no `mc` step; that flag defaults to **off**, because in production the bucket is infrastructure with lifecycle and access policies attached. The MinIO console is at <http://localhost:9001> with the credentials from `.env`, and is the quickest way to see what the upload pipeline actually wrote.

## Running the app

```bash
pnpm start:dev     # watch mode, pretty single-line logs
pnpm start         # one-shot, no watcher
pnpm build         # compile to dist/
pnpm start:prod    # node dist/main — expects NODE_ENV=production, JSON logs
```

Supporting commands:

```bash
pnpm lint          # eslint with --fix
pnpm typecheck     # tsc --noEmit over src/ and test/
pnpm format        # prettier over src/ and test/
pnpm db:studio     # drizzle-kit studio, a browser UI over the dev database
```

## Tests

```bash
pnpm test          # unit specs (src/**/*.spec.ts) — no services required
pnpm test:cov      # the same, with coverage
pnpm test:e2e      # integration specs (test/*.e2e-spec.ts)
```

`pnpm test:e2e` talks to the **real** Postgres, Redis and MinIO from docker-compose, so the stack must be up and `pnpm db:migrate` must have been run first — otherwise the database-constraint suite fails on missing tables. It reads `DATABASE_URL` from `.env` locally; in CI the job environment supplies it, and `dotenv` never overwrites an already-set variable, so the same specs run unchanged in both places.

Two suites point the real clients at dependencies that are deliberately **not** running — `menu-cache-degraded` at a closed Redis port, `object-storage-degraded` at a closed S3 endpoint. They need no setup, and they exist because a hand-written `new Error('boom')` does not reproduce the error shapes those SDKs actually raise. Between them they pin the two opposite policies: the menu cache fails **open** (Redis down still serves a menu), object storage fails **fast** (an unreachable bucket refuses the boot instead of surfacing at the first upload).

The integration suite exists to check the claims a unit test cannot: that the money and state constraints described in `DESIGN.md` §7.4 are actually armed in a migrated database, and that the HTTP hardening (body limit, CORS policy, error envelope) holds on a real server.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, build, migrations, unit tests, and integration tests against service containers of the same Postgres and Redis images used locally. It triggers on every pull request and on pushes to `main` — branch pushes are covered by the PR run rather than duplicating it.

The typecheck step is separate from the build on purpose: `pnpm build` compiles with `tsconfig.build.json`, which excludes specs, so a type error in a test file would otherwise reach `main` unnoticed.

## Configuration

Environment is parsed once at boot by `src/config/env.validation.ts`. A missing or malformed variable crashes the process immediately with a readable message rather than surfacing as `undefined` inside a request handler.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. Selects pretty vs JSON logs and the log level. |
| `PORT` | `3000` | HTTP listen port. Coerced to a number. |
| `DATABASE_URL` | — | Required. Postgres connection string; note host port `5433` for the local stack. |
| `REDIS_URL` | — | Required. Redis connection string. |
| `CORS_ORIGINS` | empty | Comma-separated browser origins allowed to call the API (KDS, public board). Empty leaves CORS **off** — native kiosk clients are not browsers and need no CORS, so the permissive case must be opted into per environment. |
| `JWT_SECRET` | — | Required, minimum 32 characters. HS256 signing key for staff access tokens. The floor is enforced because a key shorter than the digest it feeds is the weak link in the whole scheme, and a refused boot beats an API issuing forgeable tokens. |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Staff access-token lifetime (15 minutes, `DESIGN.md` §6.1). |
| `REFRESH_TOKEN_TTL_SECONDS` | `1209600` | Refresh-token lifetime (14 days, §6.1). |
| `PAIRING_CODE_TTL_SECONDS` | `600` | How long a kiosk pairing code stays usable (10 minutes, §6.2). |
| `BUSINESS_TIMEZONE` | `Asia/Bangkok` | IANA zone. What "local" means in the business-day boundary below; validated at boot, because a typo would otherwise surface as a `RangeError` inside pricing. |
| `BUSINESS_DAY_START_HOUR` | `5` | Hour the trading day rolls over (§4.5 B7, E10). An order rung up at 00:30 keeps the queue number and Z-report line of the shift that is still running. |
| `VAT_BASIS_POINTS` | `700` | VAT **extracted** from a VAT-inclusive price, never added to it (§3.3). 700 is Thailand's 7%. Basis points rather than a float rate so the arithmetic stays integral until one rounding. Set `0` if the cafe is below the registration threshold. |
| `CURRENCY` | `THB` | ISO 4217 code stamped on every order. Single-currency by design (§3.5); upper-cased to match the `char(3)` column. |
| `ORDER_EXPIRY_SECONDS` | `600` | How long an unpaid order holds its queue number before the expiry job reclaims it (FR-10). |
| `S3_BUCKET` | — | Required. Bucket holding item images. |
| `S3_REGION` | `us-east-1` | Region passed to the S3 client. MinIO ignores it; AWS does not. |
| `S3_ACCESS_KEY_ID` | — | Required. Object-storage access key. |
| `S3_SECRET_ACCESS_KEY` | — | Required. Object-storage secret key. |
| `S3_ENDPOINT` | unset | Overrides the AWS endpoint so the same client can address MinIO. Leave unset in production, where the SDK resolves the real regional endpoint. Setting it also switches the client to path-style addressing, which MinIO requires. |
| `S3_PUBLIC_BASE_URL` | — | Required. Public origin images are served from — the CDN in front of the bucket. Must be `https` anywhere but localhost: kiosks render these URLs, and a plaintext image source is both tamperable and mixed content. Trailing slashes are stripped. |
| `S3_AUTO_CREATE_BUCKET` | `false` | Creates the bucket at boot when missing, and marks it publicly readable. For MinIO and CI only. Off in production, where a bucket the app can conjure is a deployment pointed at the wrong account that nobody notices. |

`.env` is for local development only. Real secrets (production database URL, JWT signing keys, object-storage credentials, Stripe keys) come from the platform secret store and are never committed.

## Database and migrations

The schema lives in `src/database/schema/` and is the source of truth. `drizzle.config.ts` points `drizzle-kit` at it.

```bash
pnpm db:generate   # diff schema against the last snapshot, emit SQL into drizzle/
pnpm db:migrate    # apply pending migration files to DATABASE_URL
```

The workflow is: edit the schema in TypeScript, run `db:generate`, read the emitted SQL, commit both the migration and the updated `drizzle/meta` snapshot, then `db:migrate`. Never hand-edit a migration that has already been applied anywhere but your own machine.

### Seed data

```bash
pnpm db:seed       # idempotent; re-running changes nothing
```

`POST /users` is ADMIN-only (§6.4), so a freshly migrated database cannot produce a caller allowed to create the first account. `scripts/seed.ts` is that door: it inserts one staff account per role — `admin@` / `manager@` / `cashier@` / `barista@cafepos.local`, password `cafepos-dev-password` unless `SEED_PASSWORD` says otherwise — plus three categories, eight items and three shared option groups, so `GET /menu` returns something worth looking at.

It refuses to run under `NODE_ENV=production`, with no override flag, because a script that mints known-password admins is a backdoor anywhere it is not wanted. Every row is matched on its natural key and skipped if present, so a re-run never resets a password somebody changed.

Two details in the seeded menu are there to be tested against rather than to look pretty. The `Size` group prices `Small` at **−10฿**: `price_delta_minor` carries no `CHECK` (unlike `base_price_minor`), so a negative delta is legal, and keeping a line total off the floor is Phase 3's pricing job. The pastries carry **no option groups at all**, which is the shape a kiosk client has to render without assuming every item has choices attached.

> **`drizzle/0000_nasty_dagger.sql` must never be regenerated.** Its first line, `CREATE EXTENSION IF NOT EXISTS citext;`, was added by hand and `drizzle-kit` does not reproduce it: the `citext` column type is declared in the schema as a Drizzle `customType`, so the generator emits a column of type `citext` without ever emitting the extension that defines it. That type backs the case-insensitive unique email on `users` (so `A@x.com` and `a@x.com` collide on the unique index). A regenerated `0000` would therefore fail on any fresh database. Add new changes as new migration files; leave `0000` alone.

## Health endpoints

Both probes sit at the **root**, outside the API prefix, so platform orchestrators target fixed paths that never move with an API version. Both are excluded from request logging — they fire constantly and would otherwise bury real traffic.

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | Liveness. Returns `{"status":"ok"}` if the process is up. Deliberately checks no dependencies: a slow database must not get the container killed. |
| `GET /readyz` | Readiness. Pings Postgres and Redis with a 2-second timeout each. `200` when both are up, `503` otherwise. |

`/readyz` reports per-dependency status, so a failure says which one broke:

```json
{
  "status": "ok",
  "checks": { "db": { "status": "up" }, "redis": { "status": "up" } }
}
```

## API

The application API is served under the base path **`/api/v1`** (URI versioning — visible in logs and in `curl`, unlike header versioning). Conventions that apply to every endpoint are specified in `DESIGN.md` [§5.1](./DESIGN.md#5-api-specification):

- JSON in and out; `Authorization: Bearer <token>` for staff JWTs and kiosk device tokens.
- Money as integer minor units plus a currency code — `"totalMinor": 12000, "currency": "THB"` is ฿120.00.
- Timestamps ISO-8601 UTC; identifiers UUIDv7 (time-ordered, so they index and paginate well).
- Money-mutating requests accept an `Idempotency-Key` header.
- Every non-2xx response uses one RFC 9457 problem envelope carrying a stable `code` and the `requestId`. Clients switch on `code`, never on the human-readable `detail`.

Every request is assigned a correlation id, echoed as the `X-Request-Id` response header and attached to each log line and error body. An inbound `X-Request-Id` from a trusted proxy is reused only when it is a bounded, token-safe string; anything else is replaced with a generated UUID so a caller cannot forge log records or inject response headers.

### Endpoints

Roles follow the permission matrix in `DESIGN.md` [§6.4](./DESIGN.md#64-permission-matrix): A=ADMIN, M=MANAGER, C=CASHIER, B=BARISTA, K=KIOSK device.

| Method & path | Purpose | Roles |
|---|---|---|
| `POST /auth/login` | Staff login → access + refresh tokens | public |
| `POST /auth/refresh` | Rotate the refresh token → new pair | public (the token is the credential) |
| `POST /auth/logout` | Revoke the presented token's session | A, M, C, B |
| `GET /auth/me` | Describe the current principal | A, M, C, B, K |
| `POST /users` | Create a staff account | A |
| `GET /users` | List staff accounts | A, M |
| `PATCH /users/:id` | Rename, change role, activate/deactivate | A |
| `POST /devices` | Register a kiosk → one-time pairing code | A, M |
| `POST /devices/activate` | Exchange a pairing code for a device token | public (code-gated) |
| `GET /devices` | List the fleet with status and last-seen | A, M |
| `PATCH /devices/:id` | Rename, or pause/resume ordering | A, M |
| `POST /devices/:id/revoke` | Kill a tablet's token immediately | A, M |
| `GET /menu` | The whole menu in one call — categories → items → option groups → options, with `ETag` | A, M, C, B, K |
| `POST` `GET` `PATCH /categories` | Manage categories | A, M |
| `POST` `GET` `PATCH /items` | Manage items (name, price, photo, category) | A, M |
| `PATCH /items/:id/availability` | 86 / un-86 an item | A, M, C, B |
| `POST /items/:id/image` | Upload an item photo (multipart) | A, M |
| `PUT /items/:id/option-groups` | Set the ordered groups an item offers (idempotent replace) | A, M |
| `POST` `GET` `PATCH /option-groups` | Manage option groups and their min/max selections | A, M |
| `POST /option-groups/:id/options` | Add a choice to a group | A, M |
| `PATCH /options/:id` | Manage a choice (name, price delta) | A, M |
| `PATCH /options/:id/availability` | 86 / un-86 a choice | A, M, C, B |
| `POST /orders` | Place an order — priced, snapshotted and queue-numbered by the server | A, M, C, K |
| `GET /orders` | Search and page the order list (filters, cursor pagination) | A, M, C, B |
| `GET /orders/:id` | One order in full — lines, options, and its audit trail | A, M, C, B, K (own only) |
| `POST /orders/:id/status` | Advance a ticket through the kitchen (§4.4) | A, M, C, B |

The catalog `GET` routes are management reads: they return inactive categories and 86'd items, because a back office cannot restore what it cannot see. `GET /menu` is the kiosk-shaped read and is the one a device may call.

Availability toggles are separate routes from the updates beside them. That is what lets any staff member 86 the oat milk — the person who finds it gone is whoever is at the bar — without also holding the rights to reprice it.

Every route must declare either `@Public()` or `@Roles(...)`; one that declares neither is refused rather than defaulting to "any authenticated principal". `test/authz-matrix.e2e-spec.ts` sweeps every endpoint against every role and additionally fails if the application exposes a route the matrix does not list, so a new endpoint cannot merge without stating who may call it.

### Postman collection

`postman/cafepos.postman_collection.json` covers every endpoint above — import it with File → Import. It is version-controlled next to the API it describes, so a route that moves and a collection that still points at the old path show up in the same diff.

Run **Auth → Login as ADMIN** first. Its test script captures the token into a collection variable, and the collection's bearer auth hands it to every other request, so no JWT is ever pasted by hand. Logging in as MANAGER, CASHIER or BARISTA overwrites the same variable, which makes the §6.4 matrix testable by hand: sign in as BARISTA, then watch `POST /categories` refuse and `PATCH /items/:id/availability` succeed.

The same trick carries the rest of the flows — registering a kiosk captures its one-time `pairingCode`, activating captures the `deviceToken`, and `GET /menu` captures the `ETag` so the request beside it can demonstrate the `304`. Creating a category, item or option group captures its id, so the folders run top to bottom without copying UUIDs around.

Seeded credentials come from `pnpm db:seed`; the password lives in the `seedPassword` collection variable.

### Authentication

Two credential kinds arrive through the same `Authorization: Bearer` header and are told apart by shape — a JWT is three dot-separated segments, a device token is one base64url word.

- **Staff** hold a 15-minute HS256 access token plus a rotating refresh token. Rotation retires the presented token in a guarded `UPDATE`; replaying an already-rotated token revokes the entire token family, which is the standard stolen-token response (§6.1).
- **Kiosks** hold an opaque 256-bit device token stored only as a hash. It is a database row rather than a JWT precisely so revoking a stolen tablet takes effect on the next request (§6.2).

Rate limits (§10.2) are Redis-backed so they hold across instances: 20 login attempts per 15 minutes per address, 5 device activations per hour per address, and 600 requests per minute per staff user as a backstop. Separately, five *failed* logins lock a single account for 15 minutes — the two mechanisms cover different attacks and neither substitutes for the other.

When Redis is unreachable those limits deliberately stop behaving alike. The 600/min staff backstop **fails open**: it is a backstop, ordinary traffic is nowhere near it, and refusing requests to preserve it would close the cafe over a cache. Login and device activation **fail closed** with a `503 DEPENDENCY_UNAVAILABLE`, because on those two routes the limit *is* the brute-force defence, and serving them uncounted would turn an outage into an unlimited guessing window. Staff who are already signed in keep working throughout — access tokens are verified against a signature, not against Redis.

### Idempotency

`POST /orders` accepts an `Idempotency-Key` header (§5.7). It is optional, but a kiosk should always send one: the case it exists for is a tablet on flaky wifi that timed out and retried, and without a key that retry is a second order and, later, a second charge.

The header is read rather than the body because it describes the *attempt*, not the order — the same basket submitted twice on purpose is legitimately two orders, and the key is what says which of the two a request means. A replay returns the original order with `Idempotency-Replayed: true`, so a client can tell "my retry worked" from "I just created another order". The same key carrying a different basket is a `409 IDEMPOTENCY_CONFLICT`; serving either answer would be wrong, since one hands a customer someone else's receipt and the other makes the key meaningless.

Two details are load-bearing. The key row is inserted **before** the order is priced, with its response column still null — so a retry that arrives while the original is still in flight blocks on the primary key instead of racing past it. That is not a rare edge: the client only retries *because* it stopped waiting, so the concurrent case is the normal one. And because the reservation lives in the same transaction as the order, **a refused order stores nothing** — a basket rejected because an item was briefly 86'd leaves the key free, and the customer can retry the moment the pastry is back. Both are pinned in `test/orders-http.e2e-spec.ts`, the first by firing two identical requests at once and asserting exactly one of them did the work.

The fingerprint is taken from the parsed body, not the raw bytes, so a client that serialises the same basket with its JSON keys in a different order gets a replay rather than a conflict. It is also scoped to the principal, so a guessed key cannot be used to pull back another tablet's order.

### The order state machine

`DESIGN.md` §4.4 is encoded as one table in `src/orders/state/order-state.ts`, and every door that moves an order reads it. By Phase 4 there will be four such doors — the gateway webhook, a manager's refund, the expiry job, and the KDS route — and a table is the only way they can agree on what an order may do next.

**Every transition is a guarded update**: `UPDATE orders SET status = :to WHERE id = :id AND status = :from`. Two baristas tapping "start" on the same ticket both read `PAID` and both send the same request; without the guard the second silently overwrites the first and the history claims the order started twice. With it the loser updates zero rows and gets `409 ORDER_INVALID_TRANSITION` carrying the order's *actual* current status, so the screen that lost can resync from the response. §4.4 calls this the one pattern that resolves both that race (E8) and the webhook race (E2) without a lock anywhere.

`POST /orders/:id/status` deliberately exposes **only three** of the machine's edges — `PAID → IN_PREPARATION → READY → COMPLETED`. Payment, refunds, expiry and cancellation each get their own door with their own authorization. Without that second, narrower table, a barista's token could mark an order paid, and the guarded update would happily let them. Asking for a real-but-not-yours transition is a 409 about the transition, not a 422 about the field, because §8 puts transition legality in the business layer.

An order that leaves `PENDING_PAYMENT` has its `expires_at` cleared: the column stops meaning anything, and left behind it is a date a KDS would render as "expires in 3 minutes" on a drink that is already paid for.

### Searching orders

`GET /orders` is the cashier's lookup screen: `status` and `channel` as comma-separated enums, a `from`/`to` range on creation time or a `businessDay` for the cafe's own day (§4.5 B7), `q` for an exact queue number or a customer-name prefix, and `sort` restricted to a whitelist — arbitrary column sorting is both an injection surface and a licence to ask for an unindexed sort over every order the cafe has ever taken.

Paging is by **cursor, not offset**. `OFFSET 50000` degrades linearly, but the reason that matters here is the other one: an order arriving mid-scroll shifts every later page, so a cashier hunting for a customer's order can page straight past it. The cursor carries the last row's sort value *and* its id, compared as a row value — `(created_at, id) < (…, …)` — because at peak two orders share a timestamp, and comparing the sort column alone would drop whichever of them landed on the page boundary. The sort spec is baked into the cursor, so carrying one across a change of `sort` is refused rather than silently answered with the wrong window.

`GET /orders/:id` adds the line items, their option snapshots, and the status history. A kiosk may read only the orders it placed, and one belonging to another device answers **404, not 403** — §5.4 is explicit that an out-of-scope resource must be indistinguishable from a missing one, or the error code itself becomes a way for a tablet in a public space to enumerate what the cafe sold today. The e2e suite asserts the two answers are byte-identical rather than merely both-4xx.

### The menu cache

`GET /menu` is the only read a kiosk makes, so it is the one endpoint tuned for polling. A version counter in Redis keys a rendered copy of the document; the response carries `ETag: W/"catalog-<version>"` and `Cache-Control: private, no-cache`, so a kiosk asking every 10 seconds normally gets a `304` costing one Redis read and no database work. `no-cache` rather than a `max-age` is deliberate: a client-side lifetime would stack on top of the poll interval and put FR-3's 10-second propagation budget out of reach.

Every catalog write moves the version, via an interceptor on the write controllers rather than a call at the end of each service method — there are a dozen write paths, and "remember to invalidate" holds only until someone adds the thirteenth.

If Redis is unreachable the menu is still served, built fresh from Postgres and without its `catalog-` validator — so a kiosk still holding a pre-outage `ETag` gets the menu rather than a `304` that would pin it to a stale copy for as long as the outage lasts. The cache is a cache: a slower menu is a worse cafe, an erroring one is a closed cafe.

That claim is pinned over HTTP, in `test/redis-outage-http.e2e-spec.ts`. Until it was, the claim was false and the suite was green: the only degraded-Redis test exercised `MenuCacheService` in isolation against a dead port, where it degrades exactly as advertised — while the global rate-limit guard, which runs ahead of every handler, turned the whole API into 500s. A degradation claim about a *request* can only be tested by making one.

### Item images

`POST /items/:id/image` is the only multipart route in the API (§5.1's stated exception to "JSON everywhere"), and the only place the API accepts bytes it did not author. Uploads are held in memory, never written to the API's filesystem, and capped at 5 MB.

Nothing is stored as sent. The format is identified from the file's own magic bytes rather than its declared `Content-Type` — which the caller chooses — and the image is then decoded and re-encoded to WebP, bounded to a 1600px long edge. That round trip is the security posture: a polyglot file, an appended archive, or EXIF carrying the photographer's home GPS coordinates does not survive being re-rendered from pixels. SVG is refused outright, since it is a document format that can carry script and these images are served to unattended public tablets.

Stored keys are the SHA-256 of the *output*, so the same photo occupies one object however many times it is uploaded, and a key can only ever hold the bytes that hashed to it — which is what makes the immutable cache header on them safe.

## Project layout

```
src/
  config/      environment schema and boot-time validation
  common/      cross-cutting: error envelope, exception filter, request id,
               logger options, Zod validation pipe
  database/    Drizzle client, connection pool, schema/ (the tables)
  redis/       Redis client provider
  storage/     S3-compatible object storage client and writer
  health/      liveness and readiness probes
  identity/    auth/ (login, rotation, access tokens), users/, devices/
               (pairing and revocation), guards/ (authentication + §6.4 roles),
               crypto/ (argon2id passwords, opaque tokens), rate-limit/
  catalog/     categories/, items/ (incl. image upload and option-group
               attachment), option-groups/, menu/ (composite read, Redis
               cache, write-invalidation interceptor)
  orders/      pricing/ (the pure server-side pricing function), idempotency/
               (key parsing, request fingerprint, reserve-then-complete store),
               query/ (list filters, cursor pagination, detail with scoping),
               state/ (the §4.4 graph, the guarded transition primitive),
               business-day boundary, queue numbers, errors/, and the order
               aggregate write
  bootstrap.ts HTTP hardening (helmet, body limit, CORS, shutdown hooks),
               shared by main.ts and the e2e suite so it is never untested
  main.ts      composition root
drizzle/       generated migrations and snapshots
test/          integration specs
```

## Project status

Built against the phased roadmap in `DESIGN.md` [§17](./DESIGN.md#17-development-roadmap). Each phase is meant to end runnable.

- **Phase 0 — Foundations: complete.** Repo, CI, docker-compose (Postgres + Redis), the full Drizzle schema and migrations, config validation, error envelope, structured logging, and health endpoints. Its exit criterion — `docker compose up` → migrated database, `/healthz` green, CI runs tests — is what the [First-time setup](#first-time-setup) section above walks through.
- **Phase 1 — Identity: complete.** Staff auth (login, refresh with rotation and reuse detection), users CRUD with the last-admin guard, RBAC guards enforcing §6.4, kiosk device pairing/activation/pause/revocation, and the §10.2 rate limits. Its exit criterion — the AuthZ matrix sweep green — is `test/authz-matrix.e2e-spec.ts`.
- **Phase 2 — Catalog: complete.** Categories, items, option groups and options, availability toggles, the composite `GET /menu` with ETag and Redis caching, and item image upload through MinIO/S3. Its exit criterion — a kiosk-shaped client renders a menu from one call — is `test/menu-http.e2e-spec.ts`.
- **Phase 3 — Orders: in progress.** `POST /orders` is in: server-side pricing from the catalog, name and price snapshots on every line, per-business-day queue numbers, the opening status-history row, the §8 refusals (`ORDER_ITEM_UNAVAILABLE`, `OPTION_SELECTION_INVALID`, `PRICE_MISMATCH`), [idempotency keys](#idempotency), [the read side](#searching-orders) — `GET /orders` with cursor pagination and `GET /orders/:id` — and [the state machine](#the-order-state-machine) behind `POST /orders/:id/status`. Still to come before the phase's exit criterion — order → cash-paid → COMPLETED — are checkout from `DRAFT`, cancellation, the expiry job, and the cash-tender path that makes `PAID` reachable at all.

Phase 2's handover obligation is discharged. Option price deltas may be **negative**, because the schema puts no `CHECK` on `price_delta_minor` (unlike `base_price_minor`) and "small size, −10฿" is a real menu. `priceOrder` clamps a unit price the deltas drove below zero rather than refusing the order: a menu misconfigured that far is a back-office mistake, and a free croissant costs the cafe one croissant where a rejection would close every kiosk for that item until somebody noticed. What must not happen is the negative reaching the database, where one line could pay for another and a refund could exceed what was captured.

Two Phase 3 notes worth carrying forward. **Queue numbers come from a counter table, not a sequence** — a sequence is deliberately non-transactional and would leave a permanent gap behind any rolled-back checkout, so the counter row's lock is what makes B3 both unique and gapless, at the cost of serializing same-day checkouts across one short transaction. And **an item in a deactivated category is refused as unavailable rather than as unknown**: `is_active` on a category is a publish switch, so those items are absent from `GET /menu` entirely and a basket naming one is holding a stale menu — which is exactly E6.

One item from §6.1 is deliberately deferred: breached-password rejection on account creation. It needs an outbound call to a range API plus a policy for when that service is unreachable, and adding an external dependency to the account-creation path belongs with the rest of the §12.4 integrations rather than inside the auth phase. Minimum length 10 is enforced.

The schema and module boundaries were fixed in Phase 0 by the design document, so later phases add code rather than reshaping what is already here.
