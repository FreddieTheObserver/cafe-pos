import { z } from 'zod';

/**
 * The single source of truth for the environment this app needs.
 *
 * Parsed once at boot (see `validateEnv`, wired into ConfigModule). A missing
 * or malformed variable crashes the process immediately with a readable
 * message, rather than surfacing as an `undefined` deep in a request handler.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /**
   * HS256 signing key for staff access tokens (§6.1). 32 characters is the
   * floor because a key shorter than the digest it feeds is the weak link in
   * the whole scheme — and a rejected boot is a much better failure than an
   * API that issues forgeable tokens. Rotation is dual-accept (§10.5), so this
   * is the *current* signing key.
   */
  JWT_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters of high-entropy secret'),
  /**
   * 15 minutes (§6.1): short enough that the stateless-revocation gap is
   * measured in minutes, long enough that a shift's worth of requests is not
   * dominated by refreshes.
   */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  /** 14 days (§6.1) — a staff member returning after a week off stays logged in. */
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(14 * 24 * 60 * 60),
  /** 10 minutes (§6.2): the window between a manager generating a code and a kiosk typing it. */
  PAIRING_CODE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60),
  /**
   * Comma-separated browser origins allowed to call the API (KDS, public board).
   * Empty by default: same-origin and native kiosk clients need no CORS, so the
   * permissive case has to be opted into per environment.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
});

/** Fully typed, validated config shape — inferred from the schema, never drifts. */
export type Env = z.infer<typeof envSchema>;

/**
 * ConfigModule calls this with the merged process.env + .env values. Returning
 * the parsed object means downstream reads get coerced/defaulted values
 * (e.g. PORT is a number, not a string).
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}
