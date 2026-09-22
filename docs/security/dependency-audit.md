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

## Keeping it triaged

- `.github/dependabot.yml` raises grouped weekly updates for npm, GitHub Actions and the compose images.
- `.github/workflows/audit.yml` runs `pnpm audit` weekly and on demand, rather than on every push, so a newly published advisory raises a flag instead of failing an unrelated pull request.
- CI scans every commit for secrets with gitleaks; placeholders and test fixtures are allowlisted by value in `.gitleaks.toml`.
