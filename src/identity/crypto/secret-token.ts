import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 256 bits (§6.2) — the size at which guessing stops being a threat model. */
const SECRET_BYTES = 32;

/**
 * Ambiguous glyphs are removed: `0`/`O`, `1`/`I`/`L`. A manager reads this code
 * off the back-office screen and someone types it into a tablet, so a
 * transcription error costs a support call. 31 symbols over 8 characters is
 * ~40 bits — with a 10-minute TTL, single use, and a 5/hour rate limit (§10.2),
 * brute force is not on the table.
 */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const PAIRING_CODE_LENGTH = 8;

/**
 * A fresh opaque secret for a refresh token or a device token — shown to the
 * client once, never stored in the clear.
 */
export const generateSecret = (): string =>
  randomBytes(SECRET_BYTES).toString('base64url');

/**
 * Hashes an opaque secret for storage and lookup.
 *
 * SHA-256, not argon2 — and the difference is deliberate. Password hashing is
 * slow on purpose because passwords are low-entropy and guessable; these
 * secrets are 256 random bits, so there is nothing to guess and no work factor
 * worth paying on every kiosk request. It also has to be *deterministic*:
 * `refresh_tokens.token_hash` and `kiosk_devices.token_hash` are UNIQUE columns
 * we look tokens up by, which a per-call random salt would make impossible.
 */
export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/**
 * A one-time device pairing code (§6.2).
 *
 * `randomInt` rather than `randomBytes % length`: the modulo of 256 over a
 * 30-symbol alphabet is biased toward the first six symbols, and biasing a
 * credential's alphabet is exactly the kind of small mistake that shortens a
 * brute-force search.
 */
export const generatePairingCode = (): string =>
  Array.from(
    { length: PAIRING_CODE_LENGTH },
    () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)],
  ).join('');
