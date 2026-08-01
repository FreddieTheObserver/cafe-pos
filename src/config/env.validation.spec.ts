import { validateEnv } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
  S3_BUCKET: 'cafepos-media',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_PUBLIC_BASE_URL: 'https://cdn.cafe.test',
};

describe('validateEnv', () => {
  it('applies defaults for the optional variables', () => {
    const env = validateEnv({ ...REQUIRED });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('coerces PORT from the string process.env always hands us', () => {
    const env = validateEnv({ ...REQUIRED, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('names every missing variable in one readable message', () => {
    expect(() => validateEnv({})).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET/,
    );
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => validateEnv({ ...REQUIRED, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  describe('JWT_SECRET', () => {
    it('rejects a secret short enough to brute-force', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, JWT_SECRET: 'short-dev-secret' }),
      ).toThrow(/JWT_SECRET/);
    });
  });

  describe('token lifetimes', () => {
    it('defaults to the lifetimes §6.1 argues for', () => {
      const env = validateEnv({ ...REQUIRED });

      expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
      expect(env.REFRESH_TOKEN_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
      expect(env.PAIRING_CODE_TTL_SECONDS).toBe(10 * 60);
    });

    it('coerces an override from the string process.env hands us', () => {
      const env = validateEnv({ ...REQUIRED, ACCESS_TOKEN_TTL_SECONDS: '300' });

      expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(300);
    });

    it('rejects a non-positive lifetime', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, ACCESS_TOKEN_TTL_SECONDS: '0' }),
      ).toThrow(/ACCESS_TOKEN_TTL_SECONDS/);
    });
  });

  describe('CORS_ORIGINS', () => {
    it('defaults to no allowed origins', () => {
      expect(validateEnv({ ...REQUIRED }).CORS_ORIGINS).toEqual([]);
    });

    it('splits a comma-separated list and trims each entry', () => {
      const env = validateEnv({
        ...REQUIRED,
        CORS_ORIGINS: 'https://kds.cafe.test, https://kiosk.cafe.test',
      });

      expect(env.CORS_ORIGINS).toEqual([
        'https://kds.cafe.test',
        'https://kiosk.cafe.test',
      ]);
    });

    it('ignores empty entries from a trailing comma', () => {
      const env = validateEnv({
        ...REQUIRED,
        CORS_ORIGINS: 'https://kds.cafe.test,',
      });

      expect(env.CORS_ORIGINS).toEqual(['https://kds.cafe.test']);
    });
  });

  describe('object storage', () => {
    it('defaults the region and leaves the endpoint unset for real AWS', () => {
      const env = validateEnv({ ...REQUIRED });

      expect(env.S3_REGION).toBe('us-east-1');
      expect(env.S3_ENDPOINT).toBeUndefined();
    });

    /**
     * A trailing slash would build `…//items/abc.webp`, which some CDNs treat
     * as a different (and missing) key — a broken image for every item, caused
     * by one character in an env file.
     */
    it('strips trailing slashes from the public base URL', () => {
      const env = validateEnv({
        ...REQUIRED,
        S3_PUBLIC_BASE_URL: 'https://cdn.cafe.test/media//',
      });

      expect(env.S3_PUBLIC_BASE_URL).toBe('https://cdn.cafe.test/media');
    });

    // Kiosks render these URLs, so plaintext is both tamperable and mixed
    // content — but MinIO speaks http on localhost and has no TLS in front.
    it('accepts a localhost origin over plain http', () => {
      const env = validateEnv({
        ...REQUIRED,
        S3_PUBLIC_BASE_URL: 'http://localhost:9000/cafepos-media',
      });

      expect(env.S3_PUBLIC_BASE_URL).toBe(
        'http://localhost:9000/cafepos-media',
      );
    });

    it('rejects a remote origin over plain http', () => {
      expect(() =>
        validateEnv({
          ...REQUIRED,
          S3_PUBLIC_BASE_URL: 'http://cdn.cafe.test',
        }),
      ).toThrow(/S3_PUBLIC_BASE_URL/);
    });

    it('rejects a public base URL that is not a URL at all', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, S3_PUBLIC_BASE_URL: 'cdn.cafe.test' }),
      ).toThrow(/S3_PUBLIC_BASE_URL/);
    });

    describe('S3_AUTO_CREATE_BUCKET', () => {
      // Off unless explicitly turned on: in production the bucket is
      // infrastructure, and an app that can conjure one hides a deployment
      // pointed at the wrong account.
      it('is off by default', () => {
        expect(validateEnv({ ...REQUIRED }).S3_AUTO_CREATE_BUCKET).toBe(false);
      });

      it('reads "true" as the boolean, not as a truthy string', () => {
        const env = validateEnv({
          ...REQUIRED,
          S3_AUTO_CREATE_BUCKET: 'true',
        });

        expect(env.S3_AUTO_CREATE_BUCKET).toBe(true);
      });

      /**
       * `Boolean('false')` is `true`, which is how a flag meant to be off ends
       * up on. The enum refuses anything that is not exactly one of the two
       * words rather than guessing.
       */
      it('rejects a value that is neither "true" nor "false"', () => {
        expect(() =>
          validateEnv({ ...REQUIRED, S3_AUTO_CREATE_BUCKET: 'yes' }),
        ).toThrow(/S3_AUTO_CREATE_BUCKET/);
      });
    });
  });
});
