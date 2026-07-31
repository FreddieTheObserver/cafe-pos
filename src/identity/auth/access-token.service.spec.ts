import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { AccessTokenService } from './access-token.service';
import {
  TokenExpiredError,
  TokenInvalidError,
} from '../errors/identity.errors';

const SECRET = 'test-secret-at-least-32-characters-long';
const USER = {
  id: '0197f3aa-0000-7000-8000-000000000001',
  role: 'CASHIER' as const,
};

describe('AccessTokenService', () => {
  const build = (
    secret = SECRET,
    expiresIn: JwtSignOptions['expiresIn'] = 900,
  ) =>
    new AccessTokenService(
      new JwtService({ secret, signOptions: { expiresIn } }),
    );

  const service = build();

  describe('issue', () => {
    it('names the user and role so the guard needs no database read', async () => {
      const { accessToken } = await service.issue(USER);

      const principal = await service.verify(accessToken);

      expect(principal).toMatchObject({
        type: 'staff',
        userId: USER.id,
        role: USER.role,
      });
    });

    it('reports the lifetime the client should schedule a refresh against', async () => {
      const { expiresInSeconds } = await service.issue(USER);

      expect(expiresInSeconds).toBe(900);
    });

    // §10.4 floats a jti denylist for sensitive endpoints; that is only
    // possible if every token carries a distinct id from day one.
    it('gives every token a distinct jti', async () => {
      const [first, second] = await Promise.all([
        service.issue(USER),
        service.issue(USER),
      ]);

      const [a, b] = await Promise.all([
        service.verify(first.accessToken),
        service.verify(second.accessToken),
      ]);

      expect(a.tokenId).not.toBe(b.tokenId);
      expect(a.tokenId).not.toHaveLength(0);
    });
  });

  describe('verify', () => {
    it('rejects a token signed with a different secret', async () => {
      const { accessToken } = await build(
        'a-completely-different-secret-key-32',
      ).issue(USER);

      await expect(service.verify(accessToken)).rejects.toBeInstanceOf(
        TokenInvalidError,
      );
    });

    it('rejects a structurally broken token', async () => {
      await expect(service.verify('not.a.jwt')).rejects.toBeInstanceOf(
        TokenInvalidError,
      );
    });

    // Expiry is the whole revocation story for access tokens (§6.1), and the
    // client has to be able to tell "refresh me" from "your token is bogus".
    it('distinguishes an expired token from an invalid one', async () => {
      const { accessToken } = await build(SECRET, '-1s').issue(USER);

      await expect(service.verify(accessToken)).rejects.toBeInstanceOf(
        TokenExpiredError,
      );
    });

    it('refuses a token whose claims are not a staff principal', async () => {
      const jwt = new JwtService({ secret: SECRET });
      const forged = await jwt.signAsync({
        sub: USER.id,
        role: 'KIOSK',
        type: 'device',
      });

      await expect(service.verify(forged)).rejects.toBeInstanceOf(
        TokenInvalidError,
      );
    });

    it('refuses a token carrying a role that is not a staff role', async () => {
      const jwt = new JwtService({ secret: SECRET });
      const forged = await jwt.signAsync({
        sub: USER.id,
        role: 'SUPERUSER',
        type: 'staff',
      });

      await expect(service.verify(forged)).rejects.toBeInstanceOf(
        TokenInvalidError,
      );
    });
  });
});
