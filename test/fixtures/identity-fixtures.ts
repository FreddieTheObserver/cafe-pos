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

  static async boot(): Promise<IdentityHarness> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, { corsOrigins: [] });
    await app.init();

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

  async close(): Promise<void> {
    if (this.userIds.length > 0) {
      await this.db
        .delete(schema.refreshTokens)
        .where(inArray(schema.refreshTokens.userId, this.userIds));
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
    await this.app.close();
  }
}
