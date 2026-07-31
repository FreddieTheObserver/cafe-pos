import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import request from 'supertest';
import { REDIS } from '../src/redis/redis.constants';
import { uuidv7 } from 'uuidv7';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { Database } from '../src/database/database.module';
import { DRIZZLE } from '../src/database/drizzle.constants';
import * as schema from '../src/database/schema';
import { PasswordHasher } from '../src/identity/crypto/password.hasher';
import {
  generateSecret,
  hashSecret,
} from '../src/identity/crypto/secret-token';
import type { ProblemDetails } from '../src/common/errors/problem-details';

const PASSWORD = 'a-perfectly-fine-password';

/** The success shape of `/auth/login` and `/auth/refresh`; supertest types `body` as `any`. */
interface TokenBody {
  tokenType: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user?: { id: string; email: string; role: string };
}

/**
 * The auth endpoints over real HTTP, through the same `configureApp` wiring
 * production uses — so the global pipe, the exception filter and the guards are
 * all in the path, not stubbed around.
 */
describe('Auth endpoints (e2e)', () => {
  let app: NestExpressApplication;
  let db: Database;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  let staff: { id: string; email: string };
  let deviceToken: string;
  let deviceId: string;

  const http = () => request(app.getHttpServer());
  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const tokensOf = (res: { body: unknown }): TokenBody => res.body as TokenBody;

  const login = async (email = staff.email, password = PASSWORD) =>
    http().post('/api/v1/auth/login').send({ email, password });

  const refresh = (refreshToken: string) =>
    http().post('/api/v1/auth/refresh').send({ refreshToken });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, { corsOrigins: [] });
    await app.init();

    db = app.get<Database>(DRIZZLE);

    const id = uuidv7();
    staff = { id, email: `auth-http-${id}@cafepos.test` };
    await db.insert(schema.users).values({
      id,
      email: staff.email,
      passwordHash: await new PasswordHasher().hash(PASSWORD),
      displayName: 'Http Fixture',
      role: 'MANAGER',
    });
    userIds.push(id);

    deviceId = uuidv7();
    deviceToken = generateSecret();
    await db.insert(schema.kioskDevices).values({
      id: deviceId,
      name: 'E2E Kiosk',
      tokenHash: hashSecret(deviceToken),
      status: 'ACTIVE',
      registeredBy: id,
    });
    deviceIds.push(deviceId);
  });

  // Login allows twenty attempts per quarter-hour per address (§10.2); this
  // suite signs in on nearly every case. The limit is covered in its own suite.
  beforeEach(async () => {
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('throttle:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await db
      .delete(schema.refreshTokens)
      .where(inArray(schema.refreshTokens.userId, userIds));
    await db
      .delete(schema.kioskDevices)
      .where(inArray(schema.kioskDevices.id, deviceIds));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await app.close();
  });

  describe('POST /auth/login', () => {
    it('returns a token pair and the caller identity', async () => {
      const res = await login();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: expect.any(Number) as number,
        user: { id: staff.id, email: staff.email, role: 'MANAGER' },
      });
      expect(typeof tokensOf(res).accessToken).toBe('string');
      expect(typeof tokensOf(res).refreshToken).toBe('string');
    });

    it('never returns the password hash', async () => {
      const res = await login();

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('argon2');
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });

    it('answers a wrong password with 401 and the stable code', async () => {
      const res = await login(staff.email, 'wrong-password');

      expect(res.status).toBe(401);
      expect(problemOf(res).code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('rejects a malformed body with the 422 validation envelope', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: PASSWORD });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
      expect(problemOf(res).errors?.[0].field).toBe('email');
    });

    // §8 cross-cutting: unknown body fields are a client bug, caught early.
    it('rejects unknown body fields', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: staff.email, password: PASSWORD, role: 'ADMIN' });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the pair', async () => {
      const first = await login();

      const res = await refresh(tokensOf(first).refreshToken);

      expect(res.status).toBe(200);
      expect(tokensOf(res).refreshToken).not.toBe(tokensOf(first).refreshToken);
    });

    it('reports a replayed token as AUTH_REFRESH_REUSED', async () => {
      const first = await login();
      await refresh(tokensOf(first).refreshToken);

      const replay = await refresh(tokensOf(first).refreshToken);

      expect(replay.status).toBe(401);
      expect(problemOf(replay).code).toBe('AUTH_REFRESH_REUSED');
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session and answers 204', async () => {
      const session = await login();

      const res = await http()
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${tokensOf(session).accessToken}`)
        .send({ refreshToken: tokensOf(session).refreshToken });

      expect(res.status).toBe(204);

      const afterwards = await refresh(tokensOf(session).refreshToken);
      expect(afterwards.status).toBe(401);
    });

    it('requires a credential', async () => {
      const session = await login();

      const res = await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: tokensOf(session).refreshToken });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('describes the staff principal', async () => {
      const session = await login();

      const res = await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${tokensOf(session).accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        type: 'staff',
        id: staff.id,
        email: staff.email,
        displayName: 'Http Fixture',
        role: 'MANAGER',
      });
    });

    // §5.2 lists /auth/me as reachable by K — a kiosk needs to know which
    // device it is after pairing.
    it('describes the kiosk device principal', async () => {
      const res = await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${deviceToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        type: 'device',
        id: deviceId,
        name: 'E2E Kiosk',
        role: 'KIOSK',
        status: 'ACTIVE',
      });
    });

    it('refuses an anonymous caller with AUTH_TOKEN_INVALID', async () => {
      const res = await http().get('/api/v1/auth/me');

      expect(res.status).toBe(401);
      expect(problemOf(res).code).toBe('AUTH_TOKEN_INVALID');
    });

    it('reports a structurally broken token as invalid', async () => {
      const res = await http()
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer clearly.not.ajwt');

      expect(res.status).toBe(401);
      expect(problemOf(res).code).toBe('AUTH_TOKEN_INVALID');
    });

    it('refuses a revoked device token', async () => {
      const revokedToken = generateSecret();
      const revokedId = uuidv7();
      await db.insert(schema.kioskDevices).values({
        id: revokedId,
        name: 'Retired Kiosk',
        tokenHash: hashSecret(revokedToken),
        status: 'REVOKED',
        registeredBy: staff.id,
      });
      deviceIds.push(revokedId);

      const res = await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${revokedToken}`);

      expect(res.status).toBe(401);
      expect(problemOf(res).code).toBe('DEVICE_REVOKED');
    });
  });
});
