import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { PrincipalRole } from '../principal';

/**
 * The identity slice of the §9.2 catalog. Codes live next to the exceptions
 * that raise them (the convention `error-codes.ts` sets for domain phases), so
 * a code can never exist without something able to throw it.
 */
export const IdentityErrorCode = {
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_REFRESH_REUSED: 'AUTH_REFRESH_REUSED',
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  DEVICE_PAIRING_INVALID: 'DEVICE_PAIRING_INVALID',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  DEVICE_PAUSED: 'DEVICE_PAUSED',
  USER_EMAIL_EXISTS: 'USER_EMAIL_EXISTS',
  USER_LAST_ADMIN: 'USER_LAST_ADMIN',
} as const;

/**
 * Bad login (§5.2).
 *
 * One error for both "no such account" and "wrong password", with a detail
 * that describes neither: a login endpoint that distinguishes them is an
 * account-enumeration oracle, and enumeration is the first step of the
 * credential-stuffing attack §10.2 rate-limits.
 */
export class InvalidCredentialsError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.AUTH_INVALID_CREDENTIALS,
      status: 401,
      title: 'Invalid credentials',
      detail: 'The credentials provided were not accepted.',
    });
  }
}

/** Access token past its `exp`; the client should refresh rather than re-login. */
export class TokenExpiredError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.AUTH_TOKEN_EXPIRED,
      status: 401,
      title: 'Token expired',
      detail: 'The access token has expired.',
    });
  }
}

/** Malformed, wrongly signed, or structurally unusable token. */
export class TokenInvalidError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.AUTH_TOKEN_INVALID,
      status: 401,
      title: 'Token invalid',
      detail: 'The token provided could not be verified.',
    });
  }
}

/**
 * A refresh token that was already rotated came back (§6.1).
 *
 * The only way this happens is that two parties hold the same token, so the
 * whole family is revoked before this is thrown — the client is being told its
 * session is gone, not asked to try again.
 */
export class RefreshTokenReusedError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.AUTH_REFRESH_REUSED,
      status: 401,
      title: 'Refresh token reused',
      detail:
        'This refresh token was already used. The session has been revoked; sign in again.',
    });
  }
}

/** Role or scope check failed (§6.4). */
export class ForbiddenRoleError extends AppException {
  constructor(requiredRoles: readonly PrincipalRole[]) {
    super({
      code: IdentityErrorCode.FORBIDDEN_ROLE,
      status: 403,
      title: 'Forbidden',
      detail: 'This role may not perform that action.',
      // The matrix (§6.4) is published API documentation, so naming the roles
      // leaks nothing and saves an integrator a round of guesswork.
      meta: { requiredRoles: [...requiredRoles] },
    });
  }
}

/**
 * Pairing code unknown, already used, or against a device that is no longer
 * PENDING (§5.2). Never echoes the submitted code: it is a credential, and an
 * error envelope ends up in logs and on a kiosk screen.
 */
export class PairingCodeInvalidError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.DEVICE_PAIRING_INVALID,
      status: 401,
      title: 'Pairing code invalid',
      detail: 'That pairing code is not valid.',
    });
  }
}

/**
 * Pairing code recognised but past its 10-minute TTL — 410 rather than 401 so
 * the kiosk can say "ask for a new code" instead of "check your typing" (§5.2).
 */
export class PairingCodeExpiredError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.DEVICE_PAIRING_INVALID,
      status: 410,
      title: 'Pairing code expired',
      detail: 'That pairing code has expired. Generate a new one.',
    });
  }
}

/** Device token presented after the tablet was revoked (§6.2) — dead on arrival. */
export class DeviceRevokedError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.DEVICE_REVOKED,
      status: 401,
      title: 'Device revoked',
      detail: 'This device has been revoked.',
    });
  }
}

/**
 * Device is authenticated but paused (§5.2). 409, not 401: the credential is
 * fine and retrying later will work, which is exactly what a kiosk showing
 * "ordering paused" needs to know.
 */
export class DevicePausedError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.DEVICE_PAUSED,
      status: 409,
      title: 'Device paused',
      detail: 'Ordering is paused on this device.',
    });
  }
}

/**
 * A status change on a device that never completed pairing (§6.2).
 *
 * Carries the catalogue's generic `CONFLICT` rather than inventing a code:
 * §9.2 is the published contract, and a case it does not name should not
 * quietly grow one clients cannot find documented.
 */
export class DeviceNotPairedError extends AppException {
  constructor() {
    super({
      code: ErrorCode.CONFLICT,
      status: 409,
      title: 'Device not paired',
      detail:
        'This device has not completed pairing, so its status cannot be changed.',
    });
  }
}

/** `POST /users` against an email already taken (§5.2). */
export class UserEmailExistsError extends AppException {
  constructor(email: string) {
    super({
      code: IdentityErrorCode.USER_EMAIL_EXISTS,
      status: 409,
      title: 'Email already registered',
      detail: 'A staff account with that email already exists.',
      // Echoing back what the caller just sent us costs nothing and lets a
      // back-office form mark the offending field.
      meta: { email },
    });
  }
}

/**
 * Demoting or deactivating the last active ADMIN (§5.2, §8).
 *
 * 422 rather than 409: the request is well-formed and the world is consistent
 * — the operation is simply not allowed to leave the system with no one who
 * can undo it.
 */
export class LastAdminError extends AppException {
  constructor() {
    super({
      code: IdentityErrorCode.USER_LAST_ADMIN,
      status: 422,
      title: 'Last administrator',
      detail:
        'This is the last active administrator; demoting or deactivating it would lock everyone out.',
    });
  }
}
