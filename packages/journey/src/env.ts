export const PORTS = {
  api: 3200,
  metrics: 9466,
  kiosk: 5301,
  staff: 5302,
  board: 5303,
};

export const URLS = {
  api: `http://localhost:${PORTS.api}`,
  kiosk: `http://localhost:${PORTS.kiosk}`,
  staff: `http://localhost:${PORTS.staff}`,
  board: `http://localhost:${PORTS.board}`,
};

export const JOURNEY_DB = 'cafepos_journey';

// Local compose publishes Postgres on 5433; the CI job's service is on 5432.
export const PG_ADMIN_URL =
  process.env.JOURNEY_PG_ADMIN_URL ??
  'postgresql://cafepos:cafepos_dev_pw@localhost:5433/postgres';

export const REDIS_URL =
  process.env.JOURNEY_REDIS_URL ?? 'redis://localhost:6379/5';

export const STRIPE_API_BASE =
  process.env.JOURNEY_STRIPE_API_BASE ?? 'http://localhost:12111';

export const WEBHOOK_SECRET = 'whsec_ciplaceholdernotarealsecret';

export const SEED_PASSWORD = 'cafepos-dev-password';

export const databaseUrl = (): string => {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${JOURNEY_DB}`;
  return url.toString();
};

export const apiEnv = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: String(PORTS.api),
  METRICS_PORT: String(PORTS.metrics),
  DATABASE_URL: databaseUrl(),
  REDIS_URL,
  JWT_SECRET: 'ci-only-jwt-signing-key-not-used-anywhere-else',
  CORS_ORIGINS: [URLS.kiosk, URLS.staff, URLS.board].join(','),
  S3_BUCKET: 'cafepos-journey',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'cafepos',
  S3_SECRET_ACCESS_KEY: 'cafepos_dev_secret',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_BASE_URL: 'http://localhost:9000/cafepos-journey',
  S3_AUTO_CREATE_BUCKET: 'true',
  STRIPE_SECRET_KEY: 'rk_test_ciplaceholdernotarealkey',
  STRIPE_WEBHOOK_SECRETS: WEBHOOK_SECRET,
  STRIPE_API_BASE,
  SEED_PASSWORD,
});
