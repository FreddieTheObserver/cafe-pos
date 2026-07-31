import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { AccessTokenService } from '../auth/access-token.service';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import {
  DeviceRevokedError,
  TokenExpiredError,
  TokenInvalidError,
} from '../errors/identity.errors';
import type { DevicePrincipal, RequestWithPrincipal } from '../principal';
import { AuthenticationGuard } from './authentication.guard';
import type { DeviceTokenService } from '../devices/device-token.service';

const SECRET = 'test-secret-at-least-32-characters-long';
const USER = {
  id: '0197f3aa-0000-7000-8000-000000000001',
  role: 'MANAGER' as const,
};
const DEVICE_TOKEN = 'ZGV2aWNlLXRva2VuLXdpdGhvdXQtYW55LWRvdHM';

class FakeController {
  @Roles('MANAGER')
  guarded(): void {}

  @Public()
  open(): void {}
}

describe('AuthenticationGuard', () => {
  const accessTokens = new AccessTokenService(
    new JwtService({ secret: SECRET, signOptions: { expiresIn: 900 } }),
  );

  const devicePrincipal: DevicePrincipal = {
    type: 'device',
    deviceId: '0197f3aa-0000-7000-8000-0000000000d1',
    role: 'KIOSK',
  };

  /** Records what it was asked to resolve so token routing is observable. */
  const deviceTokens = (
    behaviour: (token: string) => Promise<DevicePrincipal>,
  ) => {
    const seen: string[] = [];
    const service = {
      resolve: (token: string) => {
        seen.push(token);
        return behaviour(token);
      },
    } as unknown as DeviceTokenService;
    return { service, seen };
  };

  const build = (deviceService: DeviceTokenService) =>
    new AuthenticationGuard(new Reflector(), accessTokens, deviceService);

  const contextFor = (
    handler: keyof FakeController,
    authorization?: string,
  ): { context: ExecutionContext; request: RequestWithPrincipal } => {
    const request: RequestWithPrincipal & { headers: Record<string, string> } =
      { headers: authorization ? { authorization } : {} };
    return {
      request,
      context: {
        // Never invoked — the Reflector only reads metadata off the function
        // object, so `this` binding is irrelevant here.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        getHandler: () => FakeController.prototype[handler],
        getClass: () => FakeController,
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  };

  it('lets a public route through without touching the credentials', async () => {
    const { service, seen } = deviceTokens(() =>
      Promise.reject(new Error('should not be consulted')),
    );
    const { context, request } = contextFor('open');

    await expect(build(service).canActivate(context)).resolves.toBe(true);
    expect(request.principal).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('resolves a staff principal from a bearer JWT', async () => {
    const { accessToken } = await accessTokens.issue(USER);
    const { service } = deviceTokens(() =>
      Promise.reject(new Error('should not be consulted')),
    );
    const { context, request } = contextFor('guarded', `Bearer ${accessToken}`);

    await expect(build(service).canActivate(context)).resolves.toBe(true);
    expect(request.principal).toMatchObject({
      type: 'staff',
      userId: USER.id,
      role: 'MANAGER',
    });
  });

  /**
   * §6.2 gives kiosks opaque random tokens, not JWTs. The two arrive in the
   * same header, so the guard has to route them apart on shape: a JWT is three
   * dot-separated segments, and base64url device tokens contain no dots.
   */
  it('resolves a device principal from an opaque bearer token', async () => {
    const { service, seen } = deviceTokens(() =>
      Promise.resolve(devicePrincipal),
    );
    const { context, request } = contextFor(
      'guarded',
      `Bearer ${DEVICE_TOKEN}`,
    );

    await expect(build(service).canActivate(context)).resolves.toBe(true);
    expect(seen).toEqual([DEVICE_TOKEN]);
    expect(request.principal).toEqual(devicePrincipal);
  });

  it('does not send a JWT down the device-token path', async () => {
    const { accessToken } = await accessTokens.issue(USER);
    const { service, seen } = deviceTokens(() =>
      Promise.resolve(devicePrincipal),
    );
    const { context } = contextFor('guarded', `Bearer ${accessToken}`);

    await build(service).canActivate(context);

    expect(seen).toEqual([]);
  });

  it('rejects a guarded route reached with no Authorization header', async () => {
    const { service } = deviceTokens(() => Promise.resolve(devicePrincipal));
    const { context } = contextFor('guarded');

    await expect(build(service).canActivate(context)).rejects.toBeInstanceOf(
      TokenInvalidError,
    );
  });

  it.each(['Basic abc123', 'Bearer', 'Bearer   ', 'bearer'])(
    'rejects the malformed Authorization header %p',
    async (authorization) => {
      const { service } = deviceTokens(() => Promise.resolve(devicePrincipal));
      const { context } = contextFor('guarded', authorization);

      await expect(build(service).canActivate(context)).rejects.toBeInstanceOf(
        TokenInvalidError,
      );
    },
  );

  it('accepts the scheme case-insensitively, as RFC 9110 requires', async () => {
    const { accessToken } = await accessTokens.issue(USER);
    const { service } = deviceTokens(() => Promise.resolve(devicePrincipal));
    const { context, request } = contextFor('guarded', `bearer ${accessToken}`);

    await expect(build(service).canActivate(context)).resolves.toBe(true);
    expect(request.principal).toMatchObject({ userId: USER.id });
  });

  it('surfaces an expired access token as such, not as invalid', async () => {
    const expired = await new AccessTokenService(
      new JwtService({ secret: SECRET, signOptions: { expiresIn: '-1s' } }),
    ).issue(USER);
    const { service } = deviceTokens(() => Promise.resolve(devicePrincipal));
    const { context } = contextFor('guarded', `Bearer ${expired.accessToken}`);

    await expect(build(service).canActivate(context)).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it('propagates a revoked device rather than flattening it to invalid', async () => {
    const { service } = deviceTokens(() =>
      Promise.reject(new DeviceRevokedError()),
    );
    const { context } = contextFor('guarded', `Bearer ${DEVICE_TOKEN}`);

    await expect(build(service).canActivate(context)).rejects.toBeInstanceOf(
      DeviceRevokedError,
    );
  });
});
