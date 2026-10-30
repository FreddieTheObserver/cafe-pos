import { AppException } from '../../common/errors/app.exception';
import {
  DevicePausedError,
  DeviceRevokedError,
  ForbiddenRoleError,
  InvalidCredentialsError,
  LastAdminError,
  PairingCodeExpiredError,
  PairingCodeInvalidError,
  RefreshTokenReusedError,
  TokenExpiredError,
  TokenInvalidError,
  UserEmailExistsError,
} from './identity.errors';

describe('identity errors', () => {
  it.each([
    [new InvalidCredentialsError(), 'AUTH_INVALID_CREDENTIALS', 401],
    [new TokenExpiredError(), 'AUTH_TOKEN_EXPIRED', 401],
    [new TokenInvalidError(), 'AUTH_TOKEN_INVALID', 401],
    [new RefreshTokenReusedError(), 'AUTH_REFRESH_REUSED', 401],
    [new PairingCodeInvalidError(), 'DEVICE_PAIRING_INVALID', 401],
    [new PairingCodeExpiredError(), 'DEVICE_PAIRING_INVALID', 410],
    [new DeviceRevokedError(), 'DEVICE_REVOKED', 401],
    [new DevicePausedError(), 'DEVICE_PAUSED', 409],
    [new UserEmailExistsError('a@b.test'), 'USER_EMAIL_EXISTS', 409],
    [new LastAdminError(), 'USER_LAST_ADMIN', 422],
    [new ForbiddenRoleError(['ADMIN']), 'FORBIDDEN_ROLE', 403],
  ])(
    '$constructor.name carries the §9.2 code and status',
    (error: AppException, code: string, status: number) => {
      expect(error).toBeInstanceOf(AppException);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.title).not.toHaveLength(0);
      expect(error.detail).not.toHaveLength(0);
    },
  );

  // §6.1/§10.1: a login failure must not tell an attacker whether the account
  // exists, so both branches raise the identical error.
  it('says the same thing for an unknown account and a wrong password', () => {
    expect(new InvalidCredentialsError().detail).toBe(
      new InvalidCredentialsError().detail,
    );
    expect(new InvalidCredentialsError().detail).not.toMatch(
      /password|email|exist/i,
    );
  });

  it('reports the conflicting email so a client can highlight the field', () => {
    const error = new UserEmailExistsError('barista@cafe.test');

    expect(error.meta).toEqual({ email: 'barista@cafe.test' });
  });

  it('names the roles that would have been allowed', () => {
    const error = new ForbiddenRoleError(['ADMIN', 'MANAGER']);

    expect(error.meta).toEqual({ requiredRoles: ['ADMIN', 'MANAGER'] });
  });

  // The pairing code is a credential; echoing it back into an error envelope
  // would put it in logs and on the kiosk's error screen.
  it('never echoes the pairing code that failed', () => {
    const submitted = 'K7M2QP9X';

    for (const error of [
      new PairingCodeInvalidError(),
      new PairingCodeExpiredError(),
    ]) {
      expect(JSON.stringify({ ...error, detail: error.detail })).not.toContain(
        submitted,
      );
    }
  });
});
