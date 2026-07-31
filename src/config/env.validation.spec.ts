import { validateEnv } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
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
});
