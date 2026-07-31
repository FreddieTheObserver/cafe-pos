import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { kioskDevices } from '../../database/schema';
import { hashSecret } from '../crypto/secret-token';
import {
  DeviceRevokedError,
  TokenInvalidError,
} from '../errors/identity.errors';
import type { DevicePrincipal } from '../principal';

/**
 * How stale `last_seen_at` may get before a request refreshes it.
 *
 * A kiosk polls constantly; writing a row per request would turn every read
 * into a write for no operational benefit. `GET /devices` (§5.2) shows an
 * operator whether a tablet is alive — a minute of granularity answers that
 * question exactly as well as a millisecond does.
 */
const LAST_SEEN_REFRESH_MS = 60_000;

/**
 * Resolves an opaque kiosk device token to its principal (§6.2).
 *
 * This is the DB lookup that JWTs deliberately trade away: a device credential
 * lives on an unattended tablet for months, so instant revocation is worth
 * more than stateless verification.
 */
@Injectable()
export class DeviceTokenService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async resolve(token: string): Promise<DevicePrincipal> {
    // Looked up by hash, never by the token itself — a database dump (or a
    // stray query log) then yields nothing anyone can present to the API.
    const device = await this.db.query.kioskDevices.findFirst({
      where: eq(kioskDevices.tokenHash, hashSecret(token)),
      columns: { id: true, status: true, lastSeenAt: true },
    });

    if (!device) throw new TokenInvalidError();
    if (device.status === 'REVOKED') throw new DeviceRevokedError();

    // PENDING has no token to present, and PAUSED is not a logout: pausing
    // stops ordering (§5.2), while the tablet still loads the menu to show
    // its "ordering paused" screen.
    await this.touchLastSeen(device.id, device.lastSeenAt);

    return { type: 'device', deviceId: device.id, role: 'KIOSK' };
  }

  private async touchLastSeen(
    deviceId: string,
    lastSeenAt: Date | null,
  ): Promise<void> {
    const isFresh =
      lastSeenAt !== null &&
      Date.now() - lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS;
    if (isFresh) return;

    await this.db
      .update(kioskDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(kioskDevices.id, deviceId));
  }
}
