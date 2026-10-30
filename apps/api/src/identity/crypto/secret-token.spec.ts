import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  generatePairingCode,
  generateSecret,
  hashSecret,
} from './secret-token';

describe('generateSecret', () => {
  it('carries 256 bits of entropy in a URL-safe encoding', () => {
    const secret = generateSecret();

    // 32 random bytes, base64url, unpadded.
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const secrets = new Set(
      Array.from({ length: 500 }, () => generateSecret()),
    );

    expect(secrets.size).toBe(500);
  });
});

describe('hashSecret', () => {
  it('is deterministic, so a token can be looked up by its hash', () => {
    const secret = generateSecret();

    expect(hashSecret(secret)).toBe(hashSecret(secret));
  });

  it('produces a hex SHA-256 digest that does not embed the secret', () => {
    const secret = generateSecret();

    const digest = hashSecret(secret);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(secret);
  });

  it('separates different secrets', () => {
    expect(hashSecret('token-a')).not.toBe(hashSecret('token-b'));
  });
});

describe('generatePairingCode', () => {
  it('is 8 characters a human can read off a screen', () => {
    const code = generatePairingCode();

    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(PAIRING_CODE_LENGTH).toBe(8);
  });

  // The manager reads this aloud or off a screen and someone types it into a
  // tablet, so glyphs that look alike must not be in the alphabet at all.
  it('avoids characters that are misread as one another', () => {
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01ILO]/);

    const codes = Array.from({ length: 200 }, () => generatePairingCode());

    for (const code of codes) {
      expect(code).toMatch(
        new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`),
      );
    }
  });

  it('does not collide across a realistic number of pairings', () => {
    const codes = new Set(Array.from({ length: 500 }, generatePairingCode));

    expect(codes.size).toBe(500);
  });

  it('draws on the whole alphabet rather than a biased slice', () => {
    const seen = new Set(
      Array.from({ length: 2000 }, generatePairingCode).join(''),
    );

    expect(seen.size).toBe(PAIRING_CODE_ALPHABET.length);
  });
});
