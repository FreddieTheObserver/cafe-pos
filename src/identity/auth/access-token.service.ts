import { Injectable } from '@nestjs/common';
import { JwtService, TokenExpiredError as JwtExpiredError } from '@nestjs/jwt';
import { uuidv7 } from 'uuidv7';
import { userRoles, type UserRole } from '../../database/schema/enums';
import {
  TokenExpiredError,
  TokenInvalidError,
} from '../errors/identity.errors';
import type { StaffPrincipal } from '../principal';

/**
 * Claims of a staff access token (§6.1). `type` exists so a token minted for
 * one kind of principal can never be replayed as another: without it, adding
 * any second JWT audience later would silently make those tokens valid here.
 */
interface StaffClaims {
  sub: string;
  role: string;
  type: string;
  jti: string;
  iat: number;
  exp: number;
}

const STAFF_TOKEN_TYPE = 'staff';

/**
 * Mints and verifies the 15-minute staff access tokens (§6.1).
 *
 * The signing secret and lifetime come from `JwtModule`'s async config rather
 * than being read here, which keeps this class free of `ConfigService` and
 * makes it constructible in a unit test with one line.
 */
@Injectable()
export class AccessTokenService {
  constructor(private readonly jwt: JwtService) {}

  /**
   * Issues a token for a staff user. `expiresInSeconds` is derived from the
   * token's own claims rather than re-read from config, so the number the
   * client schedules its refresh against is the one actually signed into the
   * token — the two cannot drift.
   */
  async issue(user: {
    id: string;
    role: UserRole;
  }): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      type: STAFF_TOKEN_TYPE,
      jti: uuidv7(),
    });

    const { iat, exp } = this.jwt.decode<StaffClaims>(accessToken);
    return { accessToken, expiresInSeconds: exp - iat };
  }

  /**
   * Verifies a bearer token and resolves the staff principal it names.
   *
   * Every rejection path raises a typed identity error, so the guard never has
   * to interpret a library exception — and expiry stays distinguishable from
   * invalidity, which is the difference between a client refreshing and a
   * client sending the user back to the login screen.
   */
  async verify(token: string): Promise<StaffPrincipal> {
    let claims: StaffClaims;
    try {
      claims = await this.jwt.verifyAsync<StaffClaims>(token);
    } catch (error) {
      throw error instanceof JwtExpiredError
        ? new TokenExpiredError()
        : new TokenInvalidError();
    }

    // A signature only proves we minted the token, not that its claims mean
    // what this code path assumes. Both checks below are cheap and turn a
    // future mistake elsewhere into a 401 instead of a privilege escalation.
    if (claims.type !== STAFF_TOKEN_TYPE) throw new TokenInvalidError();
    if (!isUserRole(claims.role)) throw new TokenInvalidError();

    return {
      type: 'staff',
      userId: claims.sub,
      role: claims.role,
      tokenId: claims.jti,
    };
  }
}

const isUserRole = (role: string): role is UserRole =>
  (userRoles as readonly string[]).includes(role);
