# Dependency audit

§16 asks for `npm audit` to be clean or triaged, and for Dependabot to be on.
This is the triage.

## 2026-09-22

`pnpm audit` reported 23 advisories: 19 high, 3 moderate and 1 low, across seven packages.

### Fixed

| Package | Reached through | Severity | Fix |
|---|---|---|---|
| `sharp` | direct: image upload | high | bumped to `^0.35.4` |
| `multer` | `@nestjs/platform-express`: image upload | high, low | override `multer@2: ^2.4.0` |
| `brace-expansion` | eslint, jest, Nest CLI (dev) | high | overrides per major: `^1.1.18`, `^2.1.4`, `^5.0.9` |
| `fast-uri` | Nest CLI (dev) | high | override `^3.1.6` |
| `js-yaml` | jest (dev), and a test-only direct dependency | high | overrides `^3.15.2` and `^4.3.2`; the direct use was replaced by `yaml` |
| `qs` | supertest (dev) | moderate | override `^6.16.0` |

`multer` is the one that touches shipped code: it parses the image upload.
No `@nestjs/platform-express` 11.x release depends on a patched `multer` yet, and moving to Nest 12 is a framework upgrade rather than a patch, so the fix is an override within `multer`'s own 2.x line.

Every override stays inside the major line its consumers ask for.
`pnpm audit --fix` proposes open-ended `>=` ranges instead, which would have resolved `brace-expansion@1` consumers to 5.x, a different API.
The overrides live in `pnpm-workspace.yaml`; remove each once `pnpm audit` is clean without it.

### Accepted

| Package | Reached through | Severity | Why it is accepted |
|---|---|---|---|
| `esbuild` <=0.24.2 ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) | `drizzle-kit` > `@esbuild-kit/core-utils` (dev) | moderate | The flaw is in `esbuild serve`, the development server. drizzle-kit's loader uses the transform API and never starts it. Forcing the 0.18 line to 0.25 would risk `db:generate` for a flaw that cannot be reached. |

It is listed under `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`, so `pnpm audit` exits clean and a new advisory still fails it.

## 2026-10-29

The weekly audit had failed since 2026-10-05.
`pnpm audit` reported 15 advisories, one of them the esbuild advisory accepted above: 3 critical, 5 high, 5 moderate and 2 low.

### Fixed

Every dependency was updated within its declared range, and the `0.x` OpenTelemetry packages to the versions Dependabot proposed.
`stripe` was held at 22.4.0: a newer SDK requires a newer `apiVersion`, which is a deliberate change of its own (see `src/payments/payments.module.ts`).
It was moved afterwards, on 2026-10-30, to 22.6.2 with `apiVersion` `2026-08-26.dahlia`.

| Package | Reached through | Severity | Resolved |
|---|---|---|---|
| `proxy-addr` | `express` via `@nestjs/platform-express` | critical | 2.0.7 → 2.0.8 |
| `handlebars` | `ts-jest` (dev) | critical, moderate | 4.7.9 → 4.7.10 |
| `body-parser` | `express` via `@nestjs/platform-express` | high | 2.3.0 → 2.4.0 |
| `multer` | `@nestjs/platform-express`: image upload | high | 2.4.0 → 2.5.0, override raised to `^2.5.0` |
| `engine.io` | `socket.io` | high | 6.6.9 → 6.6.11 |
| `sharp` | direct: image upload | high | 0.35.4 → 0.35.5 |
| `zod` | direct: request and config validation | high | 4.4.3 → 4.6.7 |
| `fast-copy` | `pino-pretty` (dev) | moderate | 4.0.4 → 4.3.1 |
| `fast-uri` | Nest CLI (dev) | moderate, low | 3.1.8 → 3.1.9 |

`multer` still needs its override: `@nestjs/platform-express` 11.2.8 pins 2.4.0 exactly.

The other seven overrides from 2026-09-22 (`brace-expansion` ×3, `fast-uri`, `js-yaml` ×2, `qs`) were removed.
Each was taken out alone and `pnpm audit` re-run; none of them was holding anything back any more.

`socket.io: $socket.io` in the same block is not a security override, and the removal rule above does not apply to it.
It keeps one copy of `socket.io` in the tree, because `RedisIoAdapter` subclasses Nest's `IoAdapter` and two copies make their `Server` types incompatible.

### Accepted

| Package | Reached through | Severity | Why it is accepted |
|---|---|---|---|
| `deepmerge` <=4.3.1 ([GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)) | `jest-config` and the Nest CLI's `fork-ts-checker-webpack-plugin` (dev) | low | No patched release exists. Both consumers merge this repository's own configuration, never request data, and `nest build` here runs `tsc`, not webpack. |

## Keeping it triaged

- `.github/dependabot.yml` raises grouped weekly updates for npm, GitHub Actions and the compose images.
- `.github/workflows/audit.yml` runs `pnpm audit` weekly and on demand, rather than on every push, so a newly published advisory raises a flag instead of failing an unrelated pull request.
- CI scans every commit for secrets with gitleaks; placeholders and test fixtures are allowlisted by value in `.gitleaks.toml`.
