import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, sql } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { kioskDevices } from '../../database/schema';
import type { DeviceStatus } from '../../database/schema/enums';
import {
  generatePairingCode,
  generateSecret,
  hashSecret,
} from '../crypto/secret-token';
import {
  DeviceNotPairedError,
  PairingCodeExpiredError,
  PairingCodeInvalidError,
} from '../errors/identity.errors';

/** A device as the back office sees it — no credential material, ever. */
export interface DeviceSummary {
  id: string;
  name: string;
  status: DeviceStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/** The one and only time the pairing code is readable (§6.2). */
export interface CreatedDevice extends DeviceSummary {
  pairingCode: string;
}

/** The one and only time the device token is readable (§6.2). */
export interface ActivatedDevice {
  deviceId: string;
  name: string;
  deviceToken: string;
}

export interface UpdateDeviceInput {
  name?: string;
  /** Only the pause/resume pair; retiring a tablet goes through `revoke`. */
  status?: Extract<DeviceStatus, 'ACTIVE' | 'PAUSED'>;
}

const SUMMARY_COLUMNS = {
  id: kioskDevices.id,
  name: kioskDevices.name,
  status: kioskDevices.status,
  lastSeenAt: kioskDevices.lastSeenAt,
  createdAt: kioskDevices.createdAt,
} as const;

/** Kiosk device lifecycle: pairing, activation, pause, revocation (§6.2, §5.2). */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Registers a tablet and mints its one-time pairing code (§5.2).
   *
   * The code is returned here and nowhere else: only its hash is stored, so
   * losing it means creating another device, not looking the old one up.
   */
  async create(
    input: { name: string },
    registeredBy: string,
  ): Promise<CreatedDevice> {
    const pairingCode = generatePairingCode();
    const ttl = this.config.get('PAIRING_CODE_TTL_SECONDS', { infer: true });

    const [created] = await this.db
      .insert(kioskDevices)
      .values({
        name: input.name,
        status: 'PENDING',
        pairingCodeHash: hashSecret(pairingCode),
        // Computed by Postgres so the deadline is on the database's clock, the
        // same one the activation check compares against.
        pairingExpiresAt: sql`now() + make_interval(secs => ${ttl})`,
        registeredBy,
      })
      .returning(SUMMARY_COLUMNS);

    return { ...created, pairingCode };
  }

  /**
   * Exchanges a pairing code for a long-lived device token (§6.2).
   *
   * One guarded UPDATE does the whole handshake: it matches the code, checks
   * the deadline and the PENDING state, clears the code, and writes the token
   * hash — so two kiosks racing on the same code cannot both pair, and the
   * code is spent by the same statement that accepts it.
   */
  async activate(pairingCode: string): Promise<ActivatedDevice> {
    const deviceToken = generateSecret();
    const codeHash = hashSecret(pairingCode);

    const [activated] = await this.db
      .update(kioskDevices)
      .set({
        status: 'ACTIVE',
        tokenHash: hashSecret(deviceToken),
        pairingCodeHash: null,
        pairingExpiresAt: null,
      })
      .where(
        and(
          eq(kioskDevices.pairingCodeHash, codeHash),
          eq(kioskDevices.status, 'PENDING'),
          gt(kioskDevices.pairingExpiresAt, sql`now()`),
        ),
      )
      .returning({ id: kioskDevices.id, name: kioskDevices.name });

    if (!activated) await this.explainFailedPairing(codeHash);

    return { deviceId: activated.id, name: activated.name, deviceToken };
  }

  list(): Promise<DeviceSummary[]> {
    return this.db
      .select(SUMMARY_COLUMNS)
      .from(kioskDevices)
      .orderBy(kioskDevices.createdAt);
  }

  /** Rename, or pause/resume ordering (§5.2). */
  async update(id: string, changes: UpdateDeviceInput): Promise<DeviceSummary> {
    if (changes.status !== undefined) {
      const current = await this.db.query.kioskDevices.findFirst({
        where: eq(kioskDevices.id, id),
        columns: { status: true },
      });
      if (!current) throw new ResourceNotFoundError('device', id);

      // Pausing is about a *paired* tablet taking a break. Letting this set a
      // PENDING device ACTIVE would mark it live with no token behind it, and
      // letting it resurrect a REVOKED one would undo a security action
      // through the rename endpoint.
      if (current.status !== 'ACTIVE' && current.status !== 'PAUSED') {
        throw new DeviceNotPairedError();
      }
    }

    const [updated] = await this.db
      .update(kioskDevices)
      .set(changes)
      .where(eq(kioskDevices.id, id))
      .returning(SUMMARY_COLUMNS);

    if (!updated) throw new ResourceNotFoundError('device', id);
    return updated;
  }

  /**
   * Retires a tablet (§6.2). Idempotent: whoever is revoking a stolen device
   * is probably in a hurry, and a second call should not answer with an error.
   *
   * The token hash is left in place so a later request from that tablet gets
   * DEVICE_REVOKED rather than a generic invalid-token — it is only a hash,
   * and the kiosk showing "this device was retired" is worth more.
   */
  async revoke(id: string): Promise<void> {
    const [revoked] = await this.db
      .update(kioskDevices)
      .set({ status: 'REVOKED' })
      .where(eq(kioskDevices.id, id))
      .returning({ id: kioskDevices.id });

    if (!revoked) throw new ResourceNotFoundError('device', id);
  }

  /**
   * Decides which failure the caller saw. Runs only on the failing path, so
   * the happy path stays a single statement.
   */
  private async explainFailedPairing(codeHash: string): Promise<never> {
    const device = await this.db.query.kioskDevices.findFirst({
      where: eq(kioskDevices.pairingCodeHash, codeHash),
      columns: { status: true, pairingExpiresAt: true },
    });

    const expired =
      device?.status === 'PENDING' &&
      device.pairingExpiresAt !== null &&
      device.pairingExpiresAt.getTime() <= Date.now();

    throw expired
      ? new PairingCodeExpiredError()
      : new PairingCodeInvalidError();
  }
}
