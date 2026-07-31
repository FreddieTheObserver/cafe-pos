import { Injectable } from '@nestjs/common';
import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id`, written as its value: the library ships `Algorithm` as
 * an ambient `const enum`, which our `isolatedModules` build cannot read at
 * runtime. The `Algorithm` type annotation still ties it to the library's
 * definition, and `password.hasher.spec.ts` asserts the emitted hash really
 * says `$argon2id$` — so a wrong number here fails the suite, not production.
 */
const ARGON2ID: Algorithm = 2;

/**
 * Argon2id cost parameters (§6.1: memory-hard, per-user salt).
 *
 * These are OWASP's minimum recommended settings for argon2id — 19 MiB of
 * memory, 2 passes, 1 lane — and they are stated explicitly rather than
 * inherited from the library's defaults so a dependency bump can never quietly
 * weaken every password in the database.
 *
 * The salt is generated per call by the library and travels inside the encoded
 * hash string, which is why `users.password_hash` needs no companion column.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The only place staff passwords are turned into (and checked against) stored
 * hashes. Injectable so services depend on the abstraction rather than on
 * `@node-rs/argon2` directly — the migration path if the cost parameters or the
 * algorithm ever change.
 */
@Injectable()
export class PasswordHasher {
  /** Returns the PHC-format encoded hash (`$argon2id$v=19$m=...`) to store verbatim. */
  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Checks a candidate password against a stored hash.
   *
   * A malformed stored hash resolves `false` rather than throwing: a corrupt
   * row is a credential that cannot be verified, not a server fault, and
   * turning it into a 500 would both page a human and tell an attacker that
   * this particular account's row is unusual.
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }
}
