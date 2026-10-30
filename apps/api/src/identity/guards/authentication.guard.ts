import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenService } from '../auth/access-token.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { DeviceTokenService } from '../devices/device-token.service';
import { TokenInvalidError } from '../errors/identity.errors';
import type { Principal, RequestWithPrincipal } from '../principal';

const BEARER = /^bearer\s+(\S+)$/i;

/**
 * Resolves the caller into a `Principal` and attaches it to the request.
 *
 * Staff and kiosks authenticate with different credential *kinds* through the
 * same header (§6.1, §6.2): a signed JWT the API can verify offline, and an
 * opaque token that costs a database read but dies the instant a tablet is
 * revoked. Both arrive as `Authorization: Bearer`, so this guard is where the
 * two stories converge into one principal the rest of the app can reason about.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly deviceTokens: DeviceTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Public routes are not merely unguarded — they never touch credentials at
    // all, so a malformed header on `POST /auth/login` cannot 401 the login.
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<
        RequestWithPrincipal & { headers: Record<string, string | undefined> }
      >();

    request.principal = await this.resolve(bearerTokenOf(request.headers));
    return true;
  }

  /**
   * Routes a bearer token to the right verifier by *shape*: a JWT is three
   * dot-separated base64url segments, and device tokens are single base64url
   * words with no dots. Deciding on shape rather than trying one then the other
   * means a device token is never fed to the JWT verifier — and, more
   * importantly, that a failure returns the error that actually happened
   * instead of whichever attempt failed last.
   */
  private resolve(token: string): Promise<Principal> {
    return token.includes('.')
      ? this.accessTokens.verify(token)
      : this.deviceTokens.resolve(token);
  }
}

function bearerTokenOf(headers: Record<string, string | undefined>): string {
  const match = BEARER.exec(headers.authorization ?? '');
  if (!match) throw new TokenInvalidError();
  return match[1];
}
