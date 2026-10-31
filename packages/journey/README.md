# Journey tests

Playwright tests that drive a browser through the kiosk, staff and board apps against a real API.

```bash
pnpm test:journey
```

From the repository root, this builds the API and then runs the tests.
The docker-compose stack must be up first: Postgres, Redis, SeaweedFS and stripe-mock.

## What runs

Playwright starts four processes, each on a port of its own so a development stack can stay up beside it.

- The API, from `apps/api/dist`, with settings from `src/env.ts` instead of any `.env` file.
  `scripts/start-api.mjs` first drops and recreates the `cafepos_journey` database, applies the migrations, seeds it, and empties Redis database 5.
  Every run therefore starts from the same state and the login and pairing rate limits start from zero.
- The kiosk, the staff app and the board, each built and served with `vite preview`.

The kiosk is built with fake payments, and a customer's card or QR code is replaced by a signed webhook that the test sends to the API (`src/bank.ts`).
That is the same path Stripe uses, so the order, payment and push logic all run for real.

The kiosk's order poll is set to a minute, which is longer than any assertion waits.
A screen that changes in time has therefore been told by a push, and a broken socket makes a test fail where a 3 second poll would have hidden it.

## Browsers

CI installs Playwright's own browser:

```bash
pnpm --filter @cafepos/journey exec playwright install --with-deps chromium
```

Locally, `PLAYWRIGHT_CHANNEL=msedge` uses the Edge that Windows ships, which avoids the download.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `JOURNEY_PG_ADMIN_URL` | `postgresql://cafepos:cafepos_dev_pw@localhost:5433/postgres` | A Postgres user that may create databases. CI uses port 5432. |
| `JOURNEY_REDIS_URL` | `redis://localhost:6379/5` | Emptied at the start of every run, so keep it off the database that `pnpm test:e2e` uses. |
| `JOURNEY_STRIPE_API_BASE` | `http://localhost:12111` | Where the API's Stripe client points. |
| `PLAYWRIGHT_CHANNEL` | none | A browser channel such as `msedge`, in place of the downloaded Chromium. |

Pairing is limited to 5 activations an hour per address, and Redis is emptied each run, so the suite can be run again straight away.
It uses 4 of them.

## Not covered here

Stripe's own browser pieces cannot run against stripe-mock, so the real card field, the real QR code and Stripe's webhooks are a manual check.
Run the kiosk with `VITE_PAYMENTS=stripe` against an API that holds a test-mode key, with `stripe listen` forwarding webhooks to it.
