import { validateEnv } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
  S3_BUCKET: 'cafepos-media',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_PUBLIC_BASE_URL: 'https://cdn.cafe.test',
  STRIPE_SECRET_KEY: 'rk_test_notarealkey',
  STRIPE_WEBHOOK_SECRETS: 'whsec_notarealsecret',
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

  describe('METRICS_PORT', () => {
    it('defaults to a port of its own', () => {
      expect(validateEnv({ ...REQUIRED }).METRICS_PORT).toBe(9464);
    });

    it('refuses to share the API port', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, PORT: '9000', METRICS_PORT: '9000' }),
      ).toThrow(/METRICS_PORT/);
    });

    it('rejects a port outside the TCP range', () => {
      expect(() => validateEnv({ ...REQUIRED, METRICS_PORT: '70000' })).toThrow(
        /METRICS_PORT/,
      );
    });
  });

  describe('opening hours', () => {
    it('defaults to the 07:00-20:00 window §3 states its availability against', () => {
      const env = validateEnv({ ...REQUIRED });

      expect(env.BUSINESS_OPEN_TIME).toBe('07:00');
      expect(env.BUSINESS_CLOSE_TIME).toBe('20:00');
    });

    it('rejects a time that is not HH:MM', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, BUSINESS_OPEN_TIME: '7am' }),
      ).toThrow(/BUSINESS_OPEN_TIME/);
    });

    it('rejects an hour past 23', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, BUSINESS_CLOSE_TIME: '24:00' }),
      ).toThrow(/BUSINESS_CLOSE_TIME/);
    });

    it('accepts a window that wraps past midnight', () => {
      const env = validateEnv({
        ...REQUIRED,
        BUSINESS_OPEN_TIME: '18:00',
        BUSINESS_CLOSE_TIME: '02:00',
      });

      expect(env.BUSINESS_CLOSE_TIME).toBe('02:00');
    });

    it('rejects a window that opens and closes on the same minute', () => {
      expect(() =>
        validateEnv({
          ...REQUIRED,
          BUSINESS_OPEN_TIME: '09:00',
          BUSINESS_CLOSE_TIME: '09:00',
        }),
      ).toThrow(/BUSINESS_CLOSE_TIME/);
    });
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

  describe('trading settings', () => {
    it('defaults to the single-cafe assumptions §3.5 states', () => {
      const env = validateEnv({ ...REQUIRED });

      expect(env.BUSINESS_TIMEZONE).toBe('Asia/Bangkok');
      expect(env.BUSINESS_DAY_START_HOUR).toBe(5);
      expect(env.VAT_BASIS_POINTS).toBe(700);
      expect(env.CURRENCY).toBe('THB');
      expect(env.ORDER_EXPIRY_SECONDS).toBe(10 * 60);
    });

    /**
     * Caught at boot rather than at the first order. A typo here does not fail
     * loudly on its own — `Intl` throws a `RangeError` deep inside the pricing
     * path — so the check is worth its four lines.
     */
    it('rejects a time zone the platform does not know', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, BUSINESS_TIMEZONE: 'Asia/Bangkokk' }),
      ).toThrow(/BUSINESS_TIMEZONE/);
    });

    // `Intl.supportedValuesOf` omits these, so a check written against that
    // list would refuse a zone the runtime resolves perfectly well.
    it('accepts a backward-compatibility alias', () => {
      expect(
        validateEnv({ ...REQUIRED, BUSINESS_TIMEZONE: 'Asia/Rangoon' })
          .BUSINESS_TIMEZONE,
      ).toBe('Asia/Rangoon');
    });

    it('rejects an hour outside the clock', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, BUSINESS_DAY_START_HOUR: '24' }),
      ).toThrow(/BUSINESS_DAY_START_HOUR/);
    });

    it('accepts midnight as the boundary', () => {
      expect(
        validateEnv({ ...REQUIRED, BUSINESS_DAY_START_HOUR: '0' })
          .BUSINESS_DAY_START_HOUR,
      ).toBe(0);
    });

    // A cafe below the VAT registration threshold reports no VAT at all.
    it('accepts a zero VAT rate', () => {
      expect(
        validateEnv({ ...REQUIRED, VAT_BASIS_POINTS: '0' }).VAT_BASIS_POINTS,
      ).toBe(0);
    });

    it('rejects a VAT rate above 100%', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, VAT_BASIS_POINTS: '10001' }),
      ).toThrow(/VAT_BASIS_POINTS/);
    });

    it('upper-cases the currency so it matches the char(3) column', () => {
      expect(validateEnv({ ...REQUIRED, CURRENCY: 'thb' }).CURRENCY).toBe(
        'THB',
      );
    });

    it('rejects a currency that is not three letters', () => {
      expect(() => validateEnv({ ...REQUIRED, CURRENCY: 'BAHT' })).toThrow(
        /CURRENCY/,
      );
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

    /**
     * The localhost exemption is about TLS not being terminated in front of
     * MinIO — it is not permission to use any scheme at all. `ftp://localhost`
     * parses as a URL and has a local hostname, so a rule that only looked at
     * the host would admit it and produce image URLs nothing can load.
     */
    it('rejects a non-http scheme even on localhost', () => {
      expect(() =>
        validateEnv({
          ...REQUIRED,
          S3_PUBLIC_BASE_URL: 'ftp://localhost/cafepos-media',
        }),
      ).toThrow(/S3_PUBLIC_BASE_URL/);
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

  describe('payment gateway', () => {
    describe('STRIPE_SECRET_KEY', () => {
      it('accepts a restricted key, which is the one to prefer', () => {
        const env = validateEnv({
          ...REQUIRED,
          STRIPE_SECRET_KEY: 'rk_test_abc123',
        });

        expect(env.STRIPE_SECRET_KEY).toBe('rk_test_abc123');
      });

      it('still accepts a full secret key, so a first spike is not blocked', () => {
        const env = validateEnv({
          ...REQUIRED,
          STRIPE_SECRET_KEY: 'sk_test_abc123',
        });

        expect(env.STRIPE_SECRET_KEY).toBe('sk_test_abc123');
      });

      /**
       * The publishable key is the one that belongs in a kiosk bundle, and it
       * is one transposed line away in the Dashboard. Booting with it would get
       * an authentication error from Stripe on the first order rather than at
       * deploy time — and worse, it is the mistake whose *inverse* leaks a
       * secret key to every client, so the shape is worth asserting.
       */
      it('rejects a publishable key', () => {
        expect(() =>
          validateEnv({ ...REQUIRED, STRIPE_SECRET_KEY: 'pk_test_abc123' }),
        ).toThrow(/STRIPE_SECRET_KEY/);
      });

      it('rejects a key with no mode in it', () => {
        expect(() =>
          validateEnv({ ...REQUIRED, STRIPE_SECRET_KEY: 'rk_abc123' }),
        ).toThrow(/STRIPE_SECRET_KEY/);
      });
    });

    /**
     * §16: live and test keys cannot cross. The mode is declared, not inferred
     * from the key, so a live key pasted into a test deployment, or a test key
     * into production, stops the boot instead of taking or faking real money.
     */
    describe('STRIPE_MODE', () => {
      const LIVE = {
        ...REQUIRED,
        NODE_ENV: 'production',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'rk_live_abc123',
      };

      it('defaults to test mode, where a test key boots', () => {
        expect(validateEnv({ ...REQUIRED }).STRIPE_MODE).toBe('test');
      });

      it('refuses a live key in test mode', () => {
        expect(() =>
          validateEnv({ ...REQUIRED, STRIPE_SECRET_KEY: 'rk_live_abc123' }),
        ).toThrow(/STRIPE_SECRET_KEY/);
      });

      it('refuses a test key in live mode', () => {
        expect(() =>
          validateEnv({ ...LIVE, STRIPE_SECRET_KEY: 'sk_test_abc123' }),
        ).toThrow(/STRIPE_SECRET_KEY/);
      });

      it('boots a live key in live mode in production', () => {
        expect(validateEnv(LIVE).STRIPE_MODE).toBe('live');
      });

      // A live key belongs to a production deployment, never to a laptop or a test run.
      it('refuses live mode outside production', () => {
        expect(() => validateEnv({ ...LIVE, NODE_ENV: 'development' })).toThrow(
          /STRIPE_MODE/,
        );
      });

      // A live key sent anywhere but Stripe is a live key leaked.
      it('refuses to point a live key anywhere but Stripe', () => {
        expect(() =>
          validateEnv({ ...LIVE, STRIPE_API_BASE: 'http://localhost:12111' }),
        ).toThrow(/STRIPE_API_BASE/);
      });
    });

    describe('STRIPE_WEBHOOK_SECRETS', () => {
      it('reads a single secret as a one-element list', () => {
        const env = validateEnv({ ...REQUIRED });

        expect(env.STRIPE_WEBHOOK_SECRETS).toEqual(['whsec_notarealsecret']);
      });

      /**
       * §10.5's rotation window: for 24 hours after a roll, events signed with
       * either secret are genuine. Both have to survive parsing or the endpoint
       * silently drops half its traffic — as 400s, which look like an attack
       * rather than a config change.
       */
      it('keeps both secrets through a rotation, in order', () => {
        const env = validateEnv({
          ...REQUIRED,
          STRIPE_WEBHOOK_SECRETS: 'whsec_new, whsec_old',
        });

        expect(env.STRIPE_WEBHOOK_SECRETS).toEqual(['whsec_new', 'whsec_old']);
      });

      it('rejects a secret that is not a signing secret', () => {
        expect(() =>
          validateEnv({ ...REQUIRED, STRIPE_WEBHOOK_SECRETS: 'rk_test_abc' }),
        ).toThrow(/STRIPE_WEBHOOK_SECRETS/);
      });

      /**
       * A trailing comma is what a half-finished rotation looks like. Dropping
       * the empty entry is right; ending up with *no* secrets is not, because
       * an empty list would verify against nothing and reject every event.
       */
      it('rejects a value that is only separators', () => {
        expect(() =>
          validateEnv({ ...REQUIRED, STRIPE_WEBHOOK_SECRETS: ' , , ' }),
        ).toThrow(/STRIPE_WEBHOOK_SECRETS/);
      });
    });
  });
});
