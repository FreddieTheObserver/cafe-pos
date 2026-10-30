import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

/**
 * RFC 5321's maximum path length. A cap belongs here rather than only on the
 * column: without it, an unbounded string reaches argon2 and the database.
 */
const MAX_EMAIL_LENGTH = 254;

/**
 * Long enough for any passphrase a human types, short enough that nobody can
 * bill us for a megabyte of argon2 work per login attempt.
 */
const MAX_PASSWORD_LENGTH = 200;

/**
 * `strictObject` throughout: §8 rejects unknown body fields so a client bug
 * (or a hopeful `"role": "ADMIN"`) fails loudly instead of being ignored.
 */
const LoginSchema = z.strictObject({
  email: z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email()),
  // No minimum here — a length rule on *login* only tells an attacker which
  // password policy was in force when the account was created.
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const RefreshSchema = z.strictObject({
  refreshToken: z.string().min(1).max(512),
});

export class LoginDto extends createZodDto(LoginSchema) {}
export class RefreshDto extends createZodDto(RefreshSchema) {}
