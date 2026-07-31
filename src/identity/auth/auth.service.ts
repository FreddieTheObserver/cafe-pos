import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { kioskDevices, refreshTokens, users } from '../../database/schema';
import type { DeviceStatus, UserRole } from '../../database/schema/enums';
import { PasswordHasher } from '../crypto/password.hasher';
import { generateSecret, hashSecret } from '../crypto/secret-token';
import {
  InvalidCredentialsError,
  RefreshTokenReusedError,
  TokenExpiredError,
  TokenInvalidError,
} from '../errors/identity.errors';
import type { Principal, StaffPrincipal } from '../principal';
import { AccessTokenService } from './access-token.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

/** What `GET /auth/me` answers — a staff account or a kiosk tablet. */
export type PrincipalDescription =
  | ({ type: 'staff' } & AuthenticatedUser)
  | {
      type: 'device';
      id: string;
      name: string;
      role: 'KIOSK';
      status: DeviceStatus;
    };

/**
 * A valid argon2id hash of a value nobody knows, verified against whenever the
 * email is unknown.
 *
 * Skipping the hash for a missing account makes login measurably faster for
 * emails that do not exist, which hands an attacker the account list that
 * §10.1 and the shared `InvalidCredentialsError` are there to deny. Doing the
 * work anyway costs one hash on a rate-limited endpoint.
 */
const ABSENT_USER_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Ny54wUL1ahJTvTP1ZEvIvw$ehB8O7J0xPlug57LlgrVykj2qEctN0YI6uZtPIyo6V8';

/** Staff authentication: login, rotation, and family revocation (§6.1). */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accessTokens: AccessTokenService,
    private readonly passwords: PasswordHasher,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async login(
    email: string,
    password: string,
  ): Promise<TokenPair & { user: AuthenticatedUser }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    // Verify unconditionally — see ABSENT_USER_HASH. A deactivated account is
    // also checked *after* the hash so it cannot be distinguished by timing.
    const passwordMatches = await this.passwords.verify(
      user?.passwordHash ?? ABSENT_USER_HASH,
      password,
    );

    if (!user || !user.isActive || !passwordMatches) {
      throw new InvalidCredentialsError();
    }

    // A fresh login starts a new family: sessions on the till and on the KDS
    // are independent, so revoking one leaves the other alone.
    const pair = await this.issuePair(user, uuidv7());
    return {
      ...pair,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    };
  }

  /**
   * Rotates a refresh token (§6.1).
   *
   * The retirement is a *guarded* UPDATE — `WHERE revoked_at IS NULL` — so two
   * requests racing on the same token cannot both mint a child. The loser sees
   * zero rows updated, which is indistinguishable from a genuine replay, and
   * is treated as one.
   */
  async refresh(token: string): Promise<TokenPair> {
    const tokenHash = hashSecret(token);

    const [retired] = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning();

    if (!retired) {
      await this.revokeFamilyOfReplayedToken(tokenHash);
      throw new TokenInvalidError();
    }

    if (retired.expiresAt.getTime() <= Date.now()) {
      throw new TokenExpiredError();
    }

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, retired.userId),
    });
    // Deactivation has to bite here as well as at login, or a fired employee
    // keeps renewing a session for up to 14 days.
    if (!user?.isActive) throw new InvalidCredentialsError();

    return this.issuePair(user, retired.familyId);
  }

  /**
   * Ends one session (§5.2). Scoped to the family the presented token belongs
   * to, and to the caller's own user — signing out at the till must not sign
   * you out on the KDS, and must certainly not sign out somebody else.
   */
  async logout(principal: StaffPrincipal, token: string): Promise<void> {
    const row = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, hashSecret(token)),
    });

    if (!row || row.userId !== principal.userId) {
      throw new TokenInvalidError();
    }

    await this.revokeFamily(row.familyId);
  }

  /**
   * Describes the caller for `GET /auth/me` (§5.2), which both staff clients
   * and kiosks call — a tablet needs to learn which device it became after
   * pairing, and the two answers are deliberately different shapes.
   */
  async describe(principal: Principal): Promise<PrincipalDescription> {
    if (principal.type === 'staff') {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, principal.userId),
      });
      // The token verified, so the row existed when it was minted; a hard
      // delete since then is the only way here.
      if (!user?.isActive) throw new InvalidCredentialsError();

      return {
        type: 'staff',
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      };
    }

    const device = await this.db.query.kioskDevices.findFirst({
      where: eq(kioskDevices.id, principal.deviceId),
    });
    if (!device) throw new TokenInvalidError();

    return {
      type: 'device',
      id: device.id,
      name: device.name,
      role: 'KIOSK',
      status: device.status,
    };
  }

  /**
   * A token that matched no live row is either unknown or already rotated. If
   * a revoked row still holds the hash, this is the replay §6.1 calls the
   * stolen-token tell: the family dies, including the child the legitimate
   * client is currently holding.
   */
  private async revokeFamilyOfReplayedToken(tokenHash: string): Promise<void> {
    const replayed = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
    });
    if (!replayed) return;

    await this.revokeFamily(replayed.familyId);
    throw new RefreshTokenReusedError();
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.revokedAt),
        ),
      );
  }

  private async issuePair(
    user: { id: string; role: UserRole },
    familyId: string,
  ): Promise<TokenPair> {
    const { accessToken, expiresInSeconds } =
      await this.accessTokens.issue(user);

    const refreshToken = generateSecret();
    const ttl = this.config.get('REFRESH_TOKEN_TTL_SECONDS', { infer: true });

    await this.db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashSecret(refreshToken),
      familyId,
      expiresAt: sql`now() + make_interval(secs => ${ttl})`,
    });

    return { accessToken, refreshToken, expiresInSeconds };
  }
}
