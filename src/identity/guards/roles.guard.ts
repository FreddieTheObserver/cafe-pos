import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ForbiddenRoleError } from '../errors/identity.errors';
import type { PrincipalRole, RequestWithPrincipal } from '../principal';

/**
 * Enforces the §6.4 permission matrix from `@Roles(...)` metadata.
 *
 * Runs after `AuthenticationGuard`, so by the time it sees a request the
 * principal (if any) is already resolved and attached.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const allowed = this.reflector.getAllAndOverride<PrincipalRole[]>(
      ROLES_KEY,
      targets,
    );

    // §10.4 names role creep as the risk and the matrix as the contract. A
    // route with neither decorator has no contract, so it fails closed rather
    // than defaulting to "any authenticated principal" — which is how a
    // forgotten decorator on an admin endpoint reaches a kiosk.
    //
    // Deliberately a plain Error, not an AppException: this is a server
    // misconfiguration, not something a caller can act on. It leaves as a
    // generic 500 while `AllExceptionsFilter` logs the message below with the
    // stack and request id, so the operator gets the route name and the caller
    // learns nothing about our internal structure. The authz matrix sweep
    // fails on it first, so it should never reach production at all.
    if (allowed === undefined) {
      throw new Error(
        `${context.getClass().name}.${context.getHandler().name} declares no @Roles and is not @Public — every route must state its §6.4 policy.`,
      );
    }

    const { principal } = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal>();

    if (!principal || !allowed.includes(principal.role)) {
      throw new ForbiddenRoleError(allowed);
    }

    return true;
  }
}
