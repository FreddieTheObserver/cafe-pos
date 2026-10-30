import { PasswordHasher } from './password.hasher';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();
  const password = 'correct horse battery staple';

  it('produces an argon2id hash rather than storing the password', async () => {
    const hash = await hasher.hash(password);

    expect(hash).toContain('$argon2id$');
    expect(hash).not.toContain(password);
  });

  it('accepts the password it hashed', async () => {
    const hash = await hasher.hash(password);

    await expect(hasher.verify(hash, password)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash(password);

    await expect(hasher.verify(hash, 'wrong password entirely')).resolves.toBe(
      false,
    );
  });

  it('salts per hash, so identical passwords produce different hashes', async () => {
    const [first, second] = await Promise.all([
      hasher.hash(password),
      hasher.hash(password),
    ]);

    expect(first).not.toBe(second);
  });

  // A corrupt or legacy row must not turn a login into a 500 — it is simply a
  // credential that cannot be verified.
  it('reports a malformed stored hash as a failed verification', async () => {
    await expect(hasher.verify('not-a-hash', password)).resolves.toBe(false);
  });
});
