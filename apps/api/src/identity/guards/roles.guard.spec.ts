import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { ForbiddenRoleError } from '../errors/identity.errors';
import type { Principal } from '../principal';
import { RolesGuard } from './roles.guard';

/** Stands in for a real controller so the actual decorators are under test. */
class FakeController {
  @Roles('ADMIN')
  adminOnly(): void {}

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA', 'KIOSK')
  everyPrincipal(): void {}

  @Roles('KIOSK')
  kioskOnly(): void {}

  @Public()
  publicBoard(): void {}

  /** Deliberately undecorated — the drift case §10.4 worries about. */
  forgotten(): void {}
}

const staff = (role: Principal['role']): Principal =>
  ({ type: 'staff', userId: 'u1', role, tokenId: 't1' }) as Principal;

const kiosk: Principal = { type: 'device', deviceId: 'd1', role: 'KIOSK' };

/** Returns what `run` threw, so the thrown value itself can be asserted on. */
function refusalFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the guard to refuse, but it allowed the request');
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  const contextFor = (
    handler: keyof FakeController,
    principal?: Principal,
  ): ExecutionContext =>
    ({
      // Never invoked — the Reflector only reads metadata off the function
      // object, so `this` binding is irrelevant here.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => FakeController.prototype[handler],
      getClass: () => FakeController,
      switchToHttp: () => ({ getRequest: () => ({ principal }) }),
    }) as unknown as ExecutionContext;

  it('admits a principal whose role is listed', () => {
    expect(guard.canActivate(contextFor('adminOnly', staff('ADMIN')))).toBe(
      true,
    );
  });

  it('refuses a principal whose role is not listed', () => {
    expect(() =>
      guard.canActivate(contextFor('adminOnly', staff('CASHIER'))),
    ).toThrow(ForbiddenRoleError);
  });

  it('names the allowed roles in the refusal', () => {
    const refusal = refusalFrom(() =>
      guard.canActivate(contextFor('kioskOnly', staff('ADMIN'))),
    );

    expect(refusal).toBeInstanceOf(ForbiddenRoleError);
    expect((refusal as ForbiddenRoleError).meta).toEqual({
      requiredRoles: ['KIOSK'],
    });
  });

  it('treats KIOSK as a role like any other', () => {
    expect(guard.canActivate(contextFor('kioskOnly', kiosk))).toBe(true);
    expect(guard.canActivate(contextFor('everyPrincipal', kiosk))).toBe(true);
  });

  it('lets a public route through with no principal at all', () => {
    expect(guard.canActivate(contextFor('publicBoard'))).toBe(true);
  });

  /**
   * §10.4 calls role creep the risk and the matrix the contract. A route that
   * declares neither @Public nor @Roles has no contract, so it fails closed and
   * loudly rather than quietly inheriting "any authenticated principal" — which
   * is how a forgotten decorator on an admin endpoint reaches a kiosk.
   */
  it('refuses a route that declares no policy at all', () => {
    expect(() =>
      guard.canActivate(contextFor('forgotten', staff('ADMIN'))),
    ).toThrow(/declares no @Roles/);
  });

  it('refuses a guarded route reached with no principal', () => {
    expect(() => guard.canActivate(contextFor('adminOnly'))).toThrow(
      ForbiddenRoleError,
    );
  });
});
