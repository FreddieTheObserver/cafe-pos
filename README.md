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
- **Phase 3 — Orders: next.** Order creation with server-side pricing and snapshots, queue numbers, the state machine and history, idempotency keys, list/search with cursor pagination, and the expiry job.

Phase 2 leaves Phase 3 one obligation worth stating: option price deltas may be **negative**, because the schema puts no `CHECK` on `price_delta_minor` (unlike `base_price_minor`) and "small size, −10฿" is a real menu. Keeping a line total from going below zero is server-side pricing's job, since only it sees the whole basket.

One item from §6.1 is deliberately deferred: breached-password rejection on account creation. It needs an outbound call to a range API plus a policy for when that service is unreachable, and adding an external dependency to the account-creation path belongs with the rest of the §12.4 integrations rather than inside the auth phase. Minimum length 10 is enforced.

The schema and module boundaries were fixed in Phase 0 by the design document, so later phases add code rather than reshaping what is already here.
