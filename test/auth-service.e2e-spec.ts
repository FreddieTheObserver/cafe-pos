import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import { RateLimitedError } from '../src/common/errors/rate-limited.error';
import { LoginAttemptLimiter } from '../src/identity/rate-limit/login-attempt.limiter';
import * as schema from '../src/database/schema';
import { AccessTokenService } from '../src/identity/auth/access-token.service';
import { AuthService } from '../src/identity/auth/auth.service';
import { PasswordHasher } from '../src/identity/crypto/password.hasher';
import { hashSecret } from '../src/identity/crypto/secret-token';
import {
  InvalidCredentialsError,
  RefreshTokenReusedError,
  TokenExpiredError,
  TokenInvalidError,
} from '../src/identity/errors/identity.errors';
import type { StaffPrincipal } from '../src/identity/principal';
import type { UserRole } from '../src/database/schema/enums';

const JWT_SECRET = 'integration-secret-at-least-32-characters';
const PASSWORD = 'a-perfectly-fine-password';
const REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Refresh-token rotation is the one part of §6.1 that is easy to get subtly
 * wrong, and every rule in it — rotation invalidates the old token, reuse
 * revokes the family, a rotation race has exactly one winner — is a statement
 * about rows and transactions. These run against real Postgres for that reason.
 */
describe('AuthService (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let service: AuthService;
  let redis: Redis;
  const hasher = new PasswordHasher();

  const createdUserIds: string[] = [];

  async function createUser({
    role = 'CASHIER',
    isActive = true,
    password = PASSWORD,
  }: {
    role?: UserRole;
    isActive?: boolean;
    password?: string;
  } = {}): Promise<{ id: string; email: string }> {
    const id = uuidv7();
    const email = `auth-${id}@cafepos.test`;
    await db.insert(schema.users).values({
      id,
      email,
      passwordHash: await hasher.hash(password),
      displayName: 'Auth Fixture',
      role,
      isActive,
    });
    createdUserIds.push(id);
    return { id, email };
  }

  const storedTokens = (userId: string) =>
    db.query.refreshTokens.findMany({
      where: eq(schema.refreshTokens.userId, userId),
    });

  const principalFor = (userId: string, role: UserRole): StaffPrincipal => ({
    type: 'staff',
    userId,
    role,
    tokenId: uuidv7(),
  });

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    service = new AuthService(
      db,
      new AccessTokenService(
        new JwtService({
          secret: JWT_SECRET,
          signOptions: { expiresIn: 900 },
        }),
      ),
      hasher,
      new ConfigService({ REFRESH_TOKEN_TTL_SECONDS: REFRESH_TTL_SECONDS }),
      new LoginAttemptLimiter(redis),
    );
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await db
        .delete(schema.refreshTokens)
        .where(inArray(schema.refreshTokens.userId, createdUserIds));
      await db
        .delete(schema.users)
        .where(inArray(schema.users.id, createdUserIds));
    }
    await redis.quit();
    await pool.end();
  });

  describe('login', () => {
    it('issues a usable access token and a refresh token', async () => {
      const user = await createUser({ role: 'MANAGER' });

      const result = await service.login(user.email, PASSWORD);

      expect(result.refreshToken).not.toHaveLength(0);
      expect(result.expiresInSeconds).toBe(900);
      expect(result.user).toMatchObject({ id: user.id, role: 'MANAGER' });
    });

    it('rejects a wrong password', async () => {
      const user = await createUser();

      await expect(
        service.login(user.email, 'not-the-password'),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    // §10.1: the error must not distinguish "no such account" from "wrong
    // password", or the endpoint becomes an account-enumeration oracle.
    it('rejects an unknown email with the same error a wrong password gets', async () => {
      const user = await createUser();

      const unknown = await service
        .login('nobody@cafepos.test', PASSWORD)
        .catch((error: unknown) => error);
      const wrongPassword = await service
        .login(user.email, 'not-the-password')
        .catch((error: unknown) => error);

      expect(unknown).toBeInstanceOf(InvalidCredentialsError);
      expect(JSON.stringify(unknown)).toBe(JSON.stringify(wrongPassword));
    });

    it('refuses a deactivated account', async () => {
      const user = await createUser({ isActive: false });

      await expect(service.login(user.email, PASSWORD)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    // users.email is CITEXT (§7.2), so the login path must agree with the index.
    it('matches the email case-insensitively', async () => {
      const user = await createUser();

      await expect(
        service.login(user.email.toUpperCase(), PASSWORD),
      ).resolves.toMatchObject({ user: { id: user.id } });
    });

    /**
     * §6.1: five failures per account, then a temporary lockout — and it must
     * bite on the *account*, so an attacker rotating source addresses gains
     * nothing.
     */
    it('locks the account after five wrong passwords', async () => {
      const user = await createUser();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          service.login(user.email, 'not-the-password'),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }

      await expect(service.login(user.email, PASSWORD)).rejects.toBeInstanceOf(
        RateLimitedError,
      );
    });

    it('forgets earlier failures once a sign-in succeeds', async () => {
      const user = await createUser();
      await service
        .login(user.email, 'not-the-password')
        .catch(() => undefined);

      await service.login(user.email, PASSWORD);

      const failuresAfter = await redis.get(
        `login-failures:${user.email.toLowerCase()}`,
      );
      expect(failuresAfter).toBeNull();
    });

    it('stores only the hash of the refresh token', async () => {
      const user = await createUser();

      const { refreshToken } = await service.login(user.email, PASSWORD);

      const rows = await storedTokens(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(hashSecret(refreshToken));
      expect(rows[0].tokenHash).not.toBe(refreshToken);
    });
  });

  describe('refresh', () => {
    it('returns a new pair and retires the presented token', async () => {
      const user = await createUser();
      const first = await service.login(user.email, PASSWORD);

      const second = await service.refresh(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
        RefreshTokenReusedError,
      );
    });

    it('keeps the rotated token in the same family', async () => {
      const user = await createUser();
      const first = await service.login(user.email, PASSWORD);

      await service.refresh(first.refreshToken);

      const rows = await storedTokens(user.id);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
    });

    /**
     * §6.1's stolen-token tell: the only way an already-rotated token comes
     * back is that two parties hold it, so the entire family dies rather than
     * just the replayed token.
     */
    it('revokes the whole family when a rotated token is replayed', async () => {
      const user = await createUser();
      const first = await service.login(user.email, PASSWORD);
      const second = await service.refresh(first.refreshToken);

      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
        RefreshTokenReusedError,
      );

      // The live token the thief did not have is dead too — that is the point.
      await expect(service.refresh(second.refreshToken)).rejects.toBeInstanceOf(
        RefreshTokenReusedError,
      );
      const rows = await storedTokens(user.id);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it('rejects a refresh token no row matches', async () => {
      await expect(service.refresh('never-issued')).rejects.toBeInstanceOf(
        TokenInvalidError,
      );
    });

    it('rejects an expired refresh token', async () => {
      const user = await createUser();
      const { refreshToken } = await service.login(user.email, PASSWORD);
      await db
        .update(schema.refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.refreshTokens.tokenHash, hashSecret(refreshToken)));

      await expect(service.refresh(refreshToken)).rejects.toBeInstanceOf(
        TokenExpiredError,
      );
    });

    it('refuses to refresh a session whose account was deactivated', async () => {
      const user = await createUser();
      const { refreshToken } = await service.login(user.email, PASSWORD);
      await db
        .update(schema.users)
        .set({ isActive: false })
        .where(eq(schema.users.id, user.id));

      await expect(service.refresh(refreshToken)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    /**
     * Two requests racing on one token is exactly what a stolen token looks
     * like, so the rotation must be a guarded UPDATE: without it both callers
     * read "not revoked" and the family ends up with two live children.
     */
    it('lets exactly one of two concurrent rotations win', async () => {
      const user = await createUser();
      const { refreshToken } = await service.login(user.email, PASSWORD);

      const outcomes = await Promise.allSettled([
        service.refresh(refreshToken),
        service.refresh(refreshToken),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    });
  });

  describe('logout', () => {
    it('kills the family the presented token belongs to', async () => {
      const user = await createUser();
      const { refreshToken } = await service.login(user.email, PASSWORD);

      await service.logout(principalFor(user.id, 'CASHIER'), refreshToken);

      await expect(service.refresh(refreshToken)).rejects.toBeInstanceOf(
        RefreshTokenReusedError,
      );
    });

    // Signing out at the till must not sign you out on the KDS.
    it('leaves the caller other sessions', async () => {
      const user = await createUser();
      const till = await service.login(user.email, PASSWORD);
      const kds = await service.login(user.email, PASSWORD);

      await service.logout(principalFor(user.id, 'CASHIER'), till.refreshToken);

      await expect(service.refresh(kds.refreshToken)).resolves.toBeDefined();
    });

    it('will not let one user revoke another user session', async () => {
      const victim = await createUser();
      const attacker = await createUser();
      const victimSession = await service.login(victim.email, PASSWORD);

      await expect(
        service.logout(
          principalFor(attacker.id, 'CASHIER'),
          victimSession.refreshToken,
        ),
      ).rejects.toBeInstanceOf(TokenInvalidError);

      const rows = await storedTokens(victim.id);
      expect(rows.every((row) => row.revokedAt === null)).toBe(true);
      await expect(
        service.refresh(victimSession.refreshToken),
      ).resolves.toBeDefined();
    });
  });
});
