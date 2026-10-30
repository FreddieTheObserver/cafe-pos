// Import this before anything that imports AppModule: the app validates its
// environment on import. Scanning routes connects to nothing, so syntactically
// valid placeholders are enough, and real values are never overwritten.
const PLACEHOLDERS: Record<string, string> = {
  DATABASE_URL:
    'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'placeholder-jwt-secret-for-route-scanning-only',
  S3_BUCKET: 'placeholder',
  S3_ACCESS_KEY_ID: 'placeholder',
  S3_SECRET_ACCESS_KEY: 'placeholder',
  S3_PUBLIC_BASE_URL: 'http://localhost:9000/placeholder',
  STRIPE_SECRET_KEY: 'rk_test_placeholder',
  STRIPE_WEBHOOK_SECRETS: 'whsec_placeholder',
};

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  process.env[key] ??= value;
}
