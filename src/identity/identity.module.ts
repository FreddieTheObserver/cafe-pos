import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import type { Env } from '../config/env.validation';
import { IdentityThrottlerGuard } from './rate-limit/identity-throttler.guard';
import { LoginAttemptLimiter } from './rate-limit/login-attempt.limiter';
import { RATE_LIMITS } from './rate-limit/rate-limits';
import { RedisThrottlerStorage } from './rate-limit/redis-throttler.storage';
import { AccessTokenService } from './auth/access-token.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { PasswordHasher } from './crypto/password.hasher';
import { DeviceTokenService } from './devices/device-token.service';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { AuthenticationGuard } from './guards/authentication.guard';
import { RolesGuard } from './guards/roles.guard';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

/**
 * Phase 1 (§17): staff auth, kiosk devices, and the guards enforcing §6.4.
 *
 * Both guards are registered globally and **in this order** — authentication
 * resolves the principal, then the role check reads it. Registering them here
 * rather than per-controller is what makes "every route declares a policy" an
 * enforceable rule: a new controller in any later phase is guarded the moment
 * it is added, and RolesGuard rejects it until someone says who may call it.
 */
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: {
          expiresIn: config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true }),
          algorithm: 'HS256',
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    // One throttler, overridden per route by `@RateLimit` (§10.2). The default
    // is the staff backstop, so a new endpoint is limited from the moment it
    // exists rather than from the moment somebody remembers to limit it.
    ThrottlerModule.forRoot({ throttlers: [RATE_LIMITS.staffGeneral] }),
  ],
  controllers: [AuthController, DevicesController, UsersController],
  providers: [
    AccessTokenService,
    AuthService,
    DeviceTokenService,
    DevicesService,
    PasswordHasher,
    UsersService,
    LoginAttemptLimiter,
    { provide: ThrottlerStorage, useClass: RedisThrottlerStorage },
    // Order matters and is the whole design: authenticate (so staff can be
    // counted per user), then rate-limit (so a caller cannot hammer an
    // endpoint they are forbidden from for free), then check the role.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: IdentityThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AccessTokenService, DeviceTokenService, PasswordHasher],
})
export class IdentityModule {}
