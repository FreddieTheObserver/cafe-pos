import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal, RequestWithPrincipal } from '../principal';

/**
 * Extracted from the decorator so it is directly testable — `createParamDecorator`
 * returns an opaque decorator with no seam to assert against.
 */
export function principalFromContext(
  _data: unknown,
  context: ExecutionContext,
): Principal {
  const { principal } = context
    .switchToHttp()
    .getRequest<RequestWithPrincipal>();

  // Only reachable if a route asks for a principal while declaring itself
  // @Public. That is a wiring bug, and it should surface as a 500 here rather
  // than as `undefined` flowing into a handler that may read it as permission.
  if (!principal) {
    throw new Error(
      'Handler requested @CurrentPrincipal but no principal was resolved — the route is @Public.',
    );
  }

  return principal;
}

/** Injects the authenticated principal into a handler parameter. */
export const CurrentPrincipal = createParamDecorator(principalFromContext);
