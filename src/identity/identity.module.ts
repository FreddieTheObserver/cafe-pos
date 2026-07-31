import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.validation';
import { AccessTokenService } from './auth/access-token.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { PasswordHasher } from './crypto/password.hasher';
import { DeviceTokenService } from './devices/device-token.service';
import { AuthenticationGuard } from './guards/authentication.guard';
import { RolesGuard } from './guards/roles.guard';

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
  ],
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    AuthService,
    DeviceTokenService,
    PasswordHasher,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AccessTokenService, DeviceTokenService, PasswordHasher],
})
export class IdentityModule {}
