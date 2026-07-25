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
