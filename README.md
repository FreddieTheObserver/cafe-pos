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
| Validation | Zod — for environment config and (from Phase 1) request bodies |
| Logging | pino via `nestjs-pino`, JSON in production |
| Tests | Jest (unit) + Jest/supertest against real Postgres (integration) |
| Package manager | pnpm |

## Prerequisites

- Node.js 22 (the version CI builds against)
- pnpm 10
- Docker with Compose v2, for Postgres and Redis

## First-time setup

From a fresh clone:

```bash
cp .env.example .env      # defaults already match docker-compose.yml
docker compose up -d      # Postgres on host port 5433, Redis on 6379
pnpm install
pnpm db:migrate           # applies drizzle/*.sql to the running database
pnpm start:dev
```

Then confirm the process is alive and its dependencies are reachable:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

Both should return `200`. If `/readyz` returns `503`, the body names the failing dependency — see [Health endpoints](#health-endpoints).

> **Postgres is published on host port `5433`, not `5432`.** A native PostgreSQL install commonly already owns 5432 on a developer machine, and a silent connection to the wrong server is a miserable way to lose an afternoon. `.env.example` therefore points at `5433`. CI runs on a runner with no native Postgres, so the workflow uses `5432` — that difference between `.env.example` and `.github/workflows/ci.yml` is deliberate, not drift.

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

`pnpm test:e2e` talks to the **real** Postgres from docker-compose, so the stack must be up and `pnpm db:migrate` must have been run first — otherwise the database-constraint suite fails on missing tables. It reads `DATABASE_URL` from `.env` locally; in CI the job environment supplies it, and `dotenv` never overwrites an already-set variable, so the same specs run unchanged in both places.

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

`.env` is for local development only. Real secrets (production database URL, JWT signing keys, Stripe keys) come from the platform secret store and are never committed.

## Database and migrations

The schema lives in `src/database/schema/` and is the source of truth. `drizzle.config.ts` points `drizzle-kit` at it.

```bash
pnpm db:generate   # diff schema against the last snapshot, emit SQL into drizzle/
pnpm db:migrate    # apply pending migration files to DATABASE_URL
```

The workflow is: edit the schema in TypeScript, run `db:generate`, read the emitted SQL, commit both the migration and the updated `drizzle/meta` snapshot, then `db:migrate`. Never hand-edit a migration that has already been applied anywhere but your own machine.

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

## Project layout

```
src/
  config/      environment schema and boot-time validation
  common/      cross-cutting: error envelope, exception filter, request id,
               logger options, Zod validation pipe
  database/    Drizzle client, connection pool, schema/ (the tables)
  redis/       Redis client provider
  health/      liveness and readiness probes
  bootstrap.ts HTTP hardening (helmet, body limit, CORS, shutdown hooks),
               shared by main.ts and the e2e suite so it is never untested
  main.ts      composition root
drizzle/       generated migrations and snapshots
test/          integration specs
```

## Project status

Built against the phased roadmap in `DESIGN.md` [§17](./DESIGN.md#17-development-roadmap). Each phase is meant to end runnable.

- **Phase 0 — Foundations: complete.** Repo, CI, docker-compose (Postgres + Redis), the full Drizzle schema and migrations, config validation, error envelope, structured logging, and health endpoints. Its exit criterion — `docker compose up` → migrated database, `/healthz` green, CI runs tests — is what the [First-time setup](#first-time-setup) section above walks through.
- **Phase 1 — Identity: next.** Staff auth (login, refresh, rotation), users CRUD, RBAC guards, kiosk device pairing and revocation, rate limiting.

The schema and module boundaries were fixed in Phase 0 by the design document, so later phases add code rather than reshaping what is already here.
