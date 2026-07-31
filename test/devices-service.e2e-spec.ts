import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { ResourceNotFoundError } from '../src/common/errors/resource-not-found.error';
import { hashSecret } from '../src/identity/crypto/secret-token';
import { DeviceTokenService } from '../src/identity/devices/device-token.service';
import { DevicesService } from '../src/identity/devices/devices.service';
import {
  DeviceNotPairedError,
  DeviceRevokedError,
  PairingCodeExpiredError,
  PairingCodeInvalidError,
} from '../src/identity/errors/identity.errors';

const PAIRING_TTL_SECONDS = 10 * 60;

/**
 * The pairing handshake (§6.2) is a credential exchange with a deadline and a
 * single-use rule, and every guard on it — the code dies on use, an expired
 * code is distinguishable from a wrong one, two kiosks racing on one code
 * cannot both pair — is enforced by a query. Testing it anywhere but against
 * Postgres would be testing the plan, not the behaviour.
 */
describe('DevicesService (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let service: DevicesService;
  let deviceTokens: DeviceTokenService;

  let registrarId: string;
  const createdDeviceIds: string[] = [];

  /** Creates a device through the service and remembers it for cleanup. */
  async function newDevice(name = 'Front Counter Kiosk') {
    const created = await service.create({ name }, registrarId);
    createdDeviceIds.push(created.id);
    return created;
  }

  const readDevice = (id: string) =>
    db.query.kioskDevices.findFirst({
      where: eq(schema.kioskDevices.id, id),
    });

  const expirePairing = (id: string) =>
    db
      .update(schema.kioskDevices)
      .set({ pairingExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.kioskDevices.id, id));

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    service = new DevicesService(
      db,
      new ConfigService({ PAIRING_CODE_TTL_SECONDS: PAIRING_TTL_SECONDS }),
    );
    deviceTokens = new DeviceTokenService(db);

    registrarId = uuidv7();
    await db.insert(schema.users).values({
      id: registrarId,
      email: `devices-${registrarId}@cafepos.test`,
      passwordHash: 'x',
      displayName: 'Devices Fixture Manager',
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

  describe('create', () => {
    it('returns a device awaiting pairing and the code, shown once', async () => {
      const created = await newDevice('Window Kiosk');

      expect(created).toMatchObject({
        name: 'Window Kiosk',
        status: 'PENDING',
      });
      expect(created.pairingCode).toHaveLength(8);
    });

    it('stores only the hash of the pairing code', async () => {
      const created = await newDevice();

      const row = await readDevice(created.id);
      expect(row?.pairingCodeHash).toBe(hashSecret(created.pairingCode));
      expect(row?.pairingCodeHash).not.toBe(created.pairingCode);
    });

    it('gives the code the configured lifetime and no token yet', async () => {
      const created = await newDevice();

      const row = await readDevice(created.id);
      const remainingMs = (row?.pairingExpiresAt?.getTime() ?? 0) - Date.now();
      expect(remainingMs).toBeGreaterThan((PAIRING_TTL_SECONDS - 30) * 1000);
      expect(remainingMs).toBeLessThanOrEqual(PAIRING_TTL_SECONDS * 1000);
      expect(row?.tokenHash).toBeNull();
    });

    it('records who registered it, for the audit trail', async () => {
      const created = await newDevice();

      expect((await readDevice(created.id))?.registeredBy).toBe(registrarId);
    });

    it('never issues the same pairing code twice', async () => {
      const codes = await Promise.all(
        Array.from({ length: 10 }, () => newDevice()),
      );

      expect(new Set(codes.map((c) => c.pairingCode)).size).toBe(10);
    });
  });

  describe('activate', () => {
    it('exchanges the code for a working device token', async () => {
      const created = await newDevice();

      const activated = await service.activate(created.pairingCode);

      expect(activated.deviceId).toBe(created.id);
      expect(activated.deviceToken).not.toHaveLength(0);
      await expect(
        deviceTokens.resolve(activated.deviceToken),
      ).resolves.toMatchObject({ deviceId: created.id, role: 'KIOSK' });
    });

    it('moves the device to ACTIVE and stores only the token hash', async () => {
      const created = await newDevice();

      const activated = await service.activate(created.pairingCode);

      const row = await readDevice(created.id);
      expect(row?.status).toBe('ACTIVE');
      expect(row?.tokenHash).toBe(hashSecret(activated.deviceToken));
    });

    // §6.2: single use. The code is spent the moment it works.
    it('burns the pairing code so it cannot be used again', async () => {
      const created = await newDevice();
      await service.activate(created.pairingCode);

      expect((await readDevice(created.id))?.pairingCodeHash).toBeNull();
      await expect(
        service.activate(created.pairingCode),
      ).rejects.toBeInstanceOf(PairingCodeInvalidError);
    });

    it('rejects a code nobody was issued', async () => {
      await expect(service.activate('ZZZZ9999')).rejects.toBeInstanceOf(
        PairingCodeInvalidError,
      );
    });

    /**
     * §5.2 gives expiry its own status (410) so the kiosk can say "ask for a
     * new code" instead of "check your typing" — which means the two cases
     * must stay distinguishable here.
     */
    it('reports an expired code as expired, not as wrong', async () => {
      const created = await newDevice();
      await expirePairing(created.id);

      await expect(
        service.activate(created.pairingCode),
      ).rejects.toBeInstanceOf(PairingCodeExpiredError);
    });

    it('lets exactly one of two kiosks racing on a code win', async () => {
      const created = await newDevice();

      const outcomes = await Promise.allSettled([
        service.activate(created.pairingCode),
        service.activate(created.pairingCode),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('shows status and last-seen without leaking any credential', async () => {
      const created = await newDevice();
      await service.activate(created.pairingCode);

      const devices = await service.list();

      const listed = devices.find((device) => device.id === created.id);
      expect(listed).toMatchObject({ status: 'ACTIVE' });
      expect(listed).toHaveProperty('lastSeenAt');
      expect(JSON.stringify(devices)).not.toContain('tokenHash');
      expect(JSON.stringify(devices)).not.toContain('pairingCodeHash');
    });
  });

  describe('update', () => {
    it('renames a device', async () => {
      const created = await newDevice();
      await service.activate(created.pairingCode);

      await expect(
        service.update(created.id, { name: 'Renamed Kiosk' }),
      ).resolves.toMatchObject({ name: 'Renamed Kiosk' });
    });

    it('pauses and resumes ordering', async () => {
      const created = await newDevice();
      await service.activate(created.pairingCode);

      await expect(
        service.update(created.id, { status: 'PAUSED' }),
      ).resolves.toMatchObject({ status: 'PAUSED' });
      await expect(
        service.update(created.id, { status: 'ACTIVE' }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
    });

    /**
     * Setting an unpaired device ACTIVE would mark a tablet live that never
     * completed the handshake, so the state and the credential would disagree.
     */
    it('refuses to set the status of a device that never paired', async () => {
      const created = await newDevice();

      await expect(
        service.update(created.id, { status: 'ACTIVE' }),
      ).rejects.toBeInstanceOf(DeviceNotPairedError);
    });

    it('still allows renaming a device awaiting pairing', async () => {
      const created = await newDevice();

      await expect(
        service.update(created.id, { name: 'Not Yet Paired' }),
      ).resolves.toMatchObject({ name: 'Not Yet Paired' });
    });

    it('reports an unknown device as not found', async () => {
      await expect(
        service.update(uuidv7(), { name: 'Ghost' }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('revoke', () => {
    // §6.2: the stolen-tablet path. This is why device tokens are rows.
    it('kills the token immediately', async () => {
      const created = await newDevice();
      const { deviceToken } = await service.activate(created.pairingCode);
      await expect(deviceTokens.resolve(deviceToken)).resolves.toBeDefined();

      await service.revoke(created.id);

      await expect(deviceTokens.resolve(deviceToken)).rejects.toBeInstanceOf(
        DeviceRevokedError,
      );
    });

    // Revoking a stolen tablet twice must not error at whoever is panicking.
    it('is idempotent', async () => {
      const created = await newDevice();
      await service.activate(created.pairingCode);

      await service.revoke(created.id);
      await expect(service.revoke(created.id)).resolves.toBeUndefined();
      expect((await readDevice(created.id))?.status).toBe('REVOKED');
    });

    it('reports an unknown device as not found', async () => {
      await expect(service.revoke(uuidv7())).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
    });
  });
});
