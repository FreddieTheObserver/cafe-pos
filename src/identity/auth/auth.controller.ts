import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { userRoles } from '../../database/schema/enums';
import { CurrentPrincipal } from '../decorators/current-principal.decorator';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import {
  principalRoles,
  type Principal,
  type StaffPrincipal,
} from '../principal';
import { LoginDto, RefreshDto } from './auth.dto';
import {
  AuthService,
  type PrincipalDescription,
  type TokenPair,
} from './auth.service';

/** The wire shape of a token pair — `tokenType` spelled out so clients need no convention. */
interface TokenResponse {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const tokenResponse = (pair: TokenPair): TokenResponse => ({
  tokenType: 'Bearer',
  accessToken: pair.accessToken,
  refreshToken: pair.refreshToken,
  expiresIn: pair.expiresInSeconds,
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * §5.2: 200, not Nest's default 201 — a login creates no resource the client
   * can address, and the catalog is the contract.
   */
  @Public()
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() body: LoginDto,
  ): Promise<TokenResponse & { user: PrincipalDescription }> {
    const { user, ...pair } = await this.auth.login(body.email, body.password);
    return { ...tokenResponse(pair), user: { type: 'staff', ...user } };
  }

  /**
   * Public because the refresh token *is* the credential (§5.2) — requiring a
   * live access token here would defeat the point, since clients refresh
   * precisely when theirs has expired.
   */
  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Body() body: RefreshDto): Promise<TokenResponse> {
    return tokenResponse(await this.auth.refresh(body.refreshToken));
  }

  /** Any staff role; a kiosk has no session to end (§6.2). */
  @Roles(...userRoles)
  @HttpCode(204)
  @Post('logout')
  async logout(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: RefreshDto,
  ): Promise<void> {
    await this.auth.logout(principal, body.refreshToken);
  }

  /** Every principal, kiosks included (§5.2). */
  @Roles(...principalRoles)
  @Get('me')
  me(@CurrentPrincipal() principal: Principal): Promise<PrincipalDescription> {
    return this.auth.describe(principal);
  }
}
