import type { ExecutionContext } from '@nestjs/common';
import { principalFromContext } from './current-principal.decorator';
import type { Principal } from '../principal';

const contextWith = (principal?: Principal): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  }) as unknown as ExecutionContext;

describe('@CurrentPrincipal', () => {
  it('hands the handler the principal the guard resolved', () => {
    const principal: Principal = {
      type: 'staff',
      userId: 'u1',
      role: 'ADMIN',
      tokenId: 't1',
    };

    expect(principalFromContext(undefined, contextWith(principal))).toBe(
      principal,
    );
  });

  /**
   * Reaching a handler that asks for a principal without one means the route
   * was left @Public by mistake. Returning `undefined` would push that mistake
   * into the handler as a confusing crash — or worse, a code path that treats
   * "no principal" as permission.
   */
  it('fails loudly when a route asks for a principal it never required', () => {
    expect(() => principalFromContext(undefined, contextWith())).toThrow(
      /no principal/i,
    );
  });
});
