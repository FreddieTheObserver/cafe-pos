import { z } from 'zod';

/**
 * Item images are served straight to kiosk and board clients, so a plaintext
 * origin would be a mixed-content failure in prod and a tamperable image
 * source anywhere. Localhost is the exception the rule needs: MinIO speaks
 * http on 9000 (§12.4's local stand-in for S3) and no TLS terminator sits in
 * front of it during development.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'minio']);

function isSecureOrLocal(value: string): boolean {
  try {
    const url = new URL(value);
    // The scheme is constrained in both branches. Checking only the hostname
    // for the local case would admit `ftp://localhost/...`, which parses as a
    // URL, passes a "localhost is fine" rule, and serves no images.
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether the platform's timezone database knows this name.
 *
 * Asked by construction rather than against `Intl.supportedValuesOf`, because
 * that list omits the backward-compatibility aliases (`Asia/Rangoon`,
 * `US/Eastern`) that a real deployment's `TZ` may well be set to — and those
 * resolve perfectly well. A `RangeError` here is the only authority worth
 * trusting, and getting it at boot beats getting it on the first order.
 */
function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

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
  /**
   * How this cafe trades (§16's product checklist: business-day boundary, VAT
   * rate, currency and order-expiry TTL all configurable and confirmed with the
   * owner). Every one of these is a number the owner can be wrong about in a
   * way no test would catch, so each ships a documented default rather than
   * being hardcoded somewhere in the ordering path.
   */
  BUSINESS_TIMEZONE: z
    .string()
    .min(1)
    .default('Asia/Bangkok')
    .refine(isKnownTimeZone, 'must be an IANA time zone name'),
  /**
   * The hour the trading day rolls over (B7, E10). 05:00 local is after any
   * cafe closes and before any cafe opens, so an order rung up at 00:30 keeps
   * the queue number and the Z-report line of the shift that is still running.
   */
  BUSINESS_DAY_START_HOUR: z.coerce.number().int().min(0).max(23).default(5),
  /**
   * VAT in basis points, extracted from a VAT-inclusive price rather than added
   * to it (§3.3): 700 is Thailand's 7%, and the menu price is what the customer
   * pays. Basis points keep the arithmetic integral until one rounding at the
   * end — a float rate here is how receipts start disagreeing with reports.
   *
   * A cafe below the registration threshold sets 0, which is why the floor is
   * zero rather than one.
   */
  VAT_BASIS_POINTS: z.coerce.number().int().min(0).max(10_000).default(700),
  /** ISO 4217, single-currency by design (§3.5). Matches the `char(3)` column. */
  CURRENCY: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(
      z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter ISO 4217 code'),
    )
    .default('THB'),
  /**
   * How long an unpaid order holds its queue number before the expiry job
   * reclaims it (FR-10). Ten minutes is long enough for a customer to find a
   * card and short enough that an abandoned kiosk screen clears itself before
   * the next customer reaches it.
   */
  ORDER_EXPIRY_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60),
  /**
   * Object storage for item images (§10, §12.4).
   *
   * Required rather than optional, matching how this app treats every other
   * dependency: a process that boots happily and then 500s the first time a
   * manager uploads a photo has moved a config error from deploy time to
   * business hours. `.env.example` ships values that match docker-compose, so
   * the cost of "required" is nothing for a local checkout.
   */
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /**
   * Overrides the AWS endpoint so the same client can address MinIO. Unset in
   * production, where the SDK resolves the real regional endpoint.
   */
  S3_ENDPOINT: z.url().optional(),
  /** Public origin images are read from — the CDN in front of the bucket. */
  S3_PUBLIC_BASE_URL: z
    .string()
    .min(1)
    .refine(isSecureOrLocal, 'must be an https URL (or a localhost origin)')
    // A trailing slash here would produce `...//items/abc.webp`, which some
    // CDNs treat as a distinct (and missing) key.
    .transform((value) => value.replace(/\/+$/, '')),
  /**
   * Creates the bucket at boot if it is missing. Convenience for MinIO and CI,
   * and off by default: in production the bucket is infrastructure with a
   * lifecycle policy and an access policy, and an app that can conjure one is
   * an app that quietly papers over pointing at the wrong account.
   */
  S3_AUTO_CREATE_BUCKET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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
