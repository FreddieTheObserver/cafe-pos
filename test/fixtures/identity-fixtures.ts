import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import request from 'supertest';
import { REDIS } from '../../src/redis/redis.constants';
import { uuidv7 } from 'uuidv7';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import type { Database } from '../../src/database/database.module';
import { DRIZZLE } from '../../src/database/drizzle.constants';
import * as schema from '../../src/database/schema';
import type { DeviceStatus, UserRole } from '../../src/database/schema/enums';
import { PasswordHasher } from '../../src/identity/crypto/password.hasher';
import {
  generateSecret,
  hashSecret,
} from '../../src/identity/crypto/secret-token';

export const FIXTURE_PASSWORD = 'a-perfectly-fine-password';

/**
 * Shared harness for the identity e2e suites. Boots the real `AppModule`
 * through the real `configureApp`, so nothing under test is stubbed — and
 * tracks every row it creates so a suite can clean up after itself without
 * touching rows it does not own.
 */
export class IdentityHarness {
  private constructor(
    readonly app: NestExpressApplication,
    readonly db: Database,
    private readonly userIds: string[] = [],
    private readonly deviceIds: string[] = [],
  ) {}

  /**
   * `redis` replaces the shared client for the lifetime of the app. It exists
   * for the outage suites: pointing the whole application at a dead Redis is
   * the only way to see what the request pipeline does when the dependency is
   * gone, and every other suite leaves it alone and gets the real one.
   */
  static async boot({
    redis,
  }: { redis?: Redis } = {}): Promise<IdentityHarness> {
    const builder = Test.createTestingModule({ imports: [AppModule] });
    if (redis) builder.overrideProvider(REDIS).useValue(redis);
    const moduleRef = await builder.compile();

    const app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, { corsOrigins: [] });

    // `listen(0)`, not `init()`. Handed a server that is not listening,
    // supertest calls `app.listen(0)` itself — and the request that did so
    // then closes that shared server the moment it completes. Sequential
    // requests never notice; a `Promise.all` burst has its server shut down
    // underneath it, and whichever siblings were still connecting die with
    // ECONNRESET. Binding here means the harness owns the lifetime and
    // supertest only ever borrows the address.
    await app.listen(0);

    return new IdentityHarness(app, app.get<Database>(DRIZZLE));
  }

  http() {
    return request(this.app.getHttpServer());
  }

  /** Creates a staff account with a known password and returns its identity. */
  async createStaff(
    role: UserRole,
    { isActive = true } = {},
  ): Promise<{ id: string; email: string }> {
    const id = uuidv7();
    const email = `fixture-${role.toLowerCase()}-${id}@cafepos.test`;
    await this.db.insert(schema.users).values({
      id,
      email,
      passwordHash: await new PasswordHasher().hash(FIXTURE_PASSWORD),
      displayName: `Fixture ${role}`,
      role,
      isActive,
    });
    this.userIds.push(id);
    return { id, email };
  }

  /** Logs in over HTTP so the token is minted by the same code path clients use. */
  async accessTokenFor(role: UserRole): Promise<string> {
    const { email } = await this.createStaff(role);
    const res = await this.http()
      .post('/api/v1/auth/login')
      .send({ email, password: FIXTURE_PASSWORD });

    if (res.status !== 200) {
      throw new Error(
        `fixture login for ${role} failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return (res.body as { accessToken: string }).accessToken;
  }

  /** Creates a paired kiosk and returns the raw device token. */
  async createDevice(
    status: DeviceStatus = 'ACTIVE',
  ): Promise<{ id: string; token: string }> {
    const id = uuidv7();
    const token = generateSecret();
    await this.db.insert(schema.kioskDevices).values({
      id,
      name: `Fixture Kiosk ${id}`,
      tokenHash: hashSecret(token),
      status,
    });
    this.deviceIds.push(id);
    return { id, token };
  }

  /** Registers a device this harness did not create, so cleanup still covers it. */
  trackDevice(id: string): void {
    this.deviceIds.push(id);
  }

  /**
   * Registers a user this harness did not insert, so cleanup still covers it.
   *
   * `createStaff` writes the row itself and tracks it; an account created by
   * calling `POST /users` is invisible here, and therefore never deleted. That
   * gap leaked four accounts per run out of `users-http` — twenty-four of them
   * had piled up in the development database. Call this with the id from any
   * 201, exactly as `trackDevice` is called after pairing one.
   */
  trackUser(id: string): void {
    this.userIds.push(id);
  }

  /**
   * Drops every rate-limit counter.
   *
   * A test suite hammers one endpoint from one address, which is exactly what
   * §10.2's limits exist to stop — `POST /devices/activate` allows five per
   * hour, and a suite exercising pairing blows through that in seconds. Call
   * this between cases so each one starts from the budget it assumes; a suite
   * that means to test the limit itself simply does not.
   */
  async clearRateLimits(): Promise<void> {
    const redis = this.app.get<Redis>(REDIS);
    const keys = await redis.keys('throttle:*');
    if (keys.length > 0) await redis.del(...keys);
  }

  /**
   * Removes this harness's rows and shuts the app down.
   *
   * The teardown is wrapped so `app.close()` runs even when a delete fails:
   * without that, one failed cleanup query leaves the pg pool and the Redis
   * connection open, Jest never exits, and the suite looks like it hung rather
   * than like it failed.
   */
  async close(): Promise<void> {
    try {
      if (this.userIds.length > 0) {
        await this.db
          .delete(schema.refreshTokens)
          .where(inArray(schema.refreshTokens.userId, this.userIds));
        // Devices registered *through the API* during a test reference these
        // users, so they have to go before the users do — tracked ids alone
        // would miss them and trip the foreign key.
        await this.db
          .delete(schema.kioskDevices)
          .where(inArray(schema.kioskDevices.registeredBy, this.userIds));
      }
      if (this.deviceIds.length > 0) {
        await this.db
          .delete(schema.kioskDevices)
          .where(inArray(schema.kioskDevices.id, this.deviceIds));
      }
      if (this.userIds.length > 0) {
        await this.db
          .delete(schema.users)
          .where(inArray(schema.users.id, this.userIds));
      }
    } finally {
      await this.app.close();
    }
  }
}
