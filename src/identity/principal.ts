import { userRoles, type UserRole } from '../database/schema/enums';

/**
 * The five roles of the §6.4 matrix. KIOSK is deliberately absent from
 * `userRoles` (and from the `users.role` CHECK constraint): a kiosk is a
 * device, not a staff account (§6.2), so it can never be a value in that
 * column — but it *is* a principal role the guards must reason about.
 */
export const KIOSK_ROLE = 'KIOSK' as const;

export const principalRoles = [...userRoles, KIOSK_ROLE] as const;

export type PrincipalRole = UserRole | typeof KIOSK_ROLE;

/** A signed-in staff member, resolved from a JWT access token (§6.1). */
export interface StaffPrincipal {
  type: 'staff';
  userId: string;
  role: UserRole;
  /** `jti` of the access token — the handle a future denylist (§10.4) would use. */
  tokenId: string;
}

/**
 * A kiosk tablet, resolved from an opaque device token (§6.2). Carries the
 * device id because kiosk authorization is scoped, not just role-gated: "own
 * device only" is a query filter downstream phases apply, and they need this.
 */
export interface DevicePrincipal {
  type: 'device';
  deviceId: string;
  role: typeof KIOSK_ROLE;
}

export type Principal = StaffPrincipal | DevicePrincipal;
