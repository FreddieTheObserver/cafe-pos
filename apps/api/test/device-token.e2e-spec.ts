import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { DeviceTokenService } from '../src/identity/devices/device-token.service';
import {
  generateSecret,
  hashSecret,
} from '../src/identity/crypto/secret-token';
import {
  DeviceRevokedError,
  TokenInvalidError,
} from '../src/identity/errors/identity.errors';
import type { DeviceStatus } from '../src/database/schema/enums';

/**
 * Device tokens are the credential a 24/7 unattended tablet carries (§6.2), and
 * every rule about them — revocation is instant, pausing is not a logout,
 * last-seen is recorded — is a statement about rows in Postgres. Mocking the
 * database here would test the mock's opinion of those rules instead.
 */
describe('DeviceTokenService (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let service: DeviceTokenService;

  const registrarId = uuidv7();
  const createdDeviceIds: string[] = [];

  /** Creates a device holding a freshly minted token and returns the raw token. */
  async function deviceWithToken(
    status: DeviceStatus,
    overrides: { lastSeenAt?: Date } = {},
  ): Promise<{ deviceId: string; token: string }> {
    const deviceId = uuidv7();
    const token = generateSecret();
    await db.insert(schema.kioskDevices).values({
      id: deviceId,
      name: `Token Fixture ${deviceId}`,
      tokenHash: hashSecret(token),
      status,
      registeredBy: registrarId,
      lastSeenAt: overrides.lastSeenAt ?? null,
    });
    createdDeviceIds.push(deviceId);
    return { deviceId, token };
  }

  const readDevice = async (deviceId: string) =>
    db.query.kioskDevices.findFirst({
      where: eq(schema.kioskDevices.id, deviceId),
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    service = new DeviceTokenService(db);

    await db.insert(schema.users).values({
      id: registrarId,
      email: `device-token-${registrarId}@cafepos.test`,
      passwordHash: 'x',
      displayName: 'Device Fixture Manager',
      role: 'MANAGER',
    });
  });

  afterAll(async () => {
    if (createdDeviceIds.length > 0) {
      await db
        .delete(schema.kioskDevices)
        .where(inArray(schema.kioskDevices.id, createdDeviceIds));
    }
    await db.delete(schema.users).where(eq(schema.users.id, registrarId));
    await pool.end();
  });

  it('resolves an active device token to a KIOSK principal scoped to that device', async () => {
    const { deviceId, token } = await deviceWithToken('ACTIVE');

    await expect(service.resolve(token)).resolves.toEqual({
      type: 'device',
      deviceId,
      role: 'KIOSK',
    });
  });

  /**
   * Pausing stops *ordering*, not authentication (§5.2): a paused kiosk still
   * needs to load the menu and show "ordering paused". Rejecting it here would
   * push the tablet into a re-pairing loop over what is a temporary state.
   */
  it('still authenticates a paused device', async () => {
    const { deviceId, token } = await deviceWithToken('PAUSED');

    await expect(service.resolve(token)).resolves.toMatchObject({ deviceId });
  });

  // §6.2: the whole reason device tokens are DB rows rather than JWTs.
  it('refuses a revoked device immediately', async () => {
    const { token } = await deviceWithToken('REVOKED');

    await expect(service.resolve(token)).rejects.toBeInstanceOf(
      DeviceRevokedError,
    );
  });

  it('refuses a token no device holds', async () => {
    await expect(service.resolve(generateSecret())).rejects.toBeInstanceOf(
      TokenInvalidError,
    );
  });

  it('refuses a revoked device even after its token hash is cleared', async () => {
    const { deviceId, token } = await deviceWithToken('ACTIVE');
    await db
      .update(schema.kioskDevices)
      .set({ status: 'REVOKED', tokenHash: null })
      .where(eq(schema.kioskDevices.id, deviceId));

    await expect(service.resolve(token)).rejects.toBeInstanceOf(
      TokenInvalidError,
    );
  });

  describe('last-seen tracking', () => {
    it('records when a device was last heard from', async () => {
      const { deviceId, token } = await deviceWithToken('ACTIVE');

      await service.resolve(token);

      const device = await readDevice(deviceId);
      expect(device?.lastSeenAt).toBeInstanceOf(Date);
      expect(Date.now() - (device?.lastSeenAt?.getTime() ?? 0)).toBeLessThan(
        10_000,
      );
    });

    /**
     * A kiosk hits the API constantly; writing a row on every request would
     * turn a read path into a write path for no operational gain. `GET /devices`
     * needs "last seen" to the minute, not to the millisecond.
     */
    it('does not rewrite last-seen on every request', async () => {
      const justNow = new Date();
      const { deviceId, token } = await deviceWithToken('ACTIVE', {
        lastSeenAt: justNow,
      });

      await service.resolve(token);

      const device = await readDevice(deviceId);
      expect(device?.lastSeenAt?.getTime()).toBe(justNow.getTime());
    });

    it('refreshes last-seen once it has gone stale', async () => {
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      const { deviceId, token } = await deviceWithToken('ACTIVE', {
        lastSeenAt: longAgo,
      });

      await service.resolve(token);

      const device = await readDevice(deviceId);
      expect(device?.lastSeenAt?.getTime()).toBeGreaterThan(longAgo.getTime());
    });
  });
});
