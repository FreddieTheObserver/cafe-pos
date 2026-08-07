import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { buildLoggerOptions } from './common/logging/pino-options';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildLoggerOptions,
    }),
    /**
     * Backs the §5.2 background jobs — order expiry now, rollups and retention
     * later. Registered here rather than inside `OrdersModule` because it is
     * process-wide plumbing: one scheduler, whatever declares work for it.
     */
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    StorageModule,
    CommonModule,
    HealthModule,
    IdentityModule,
    CatalogModule,
    OrdersModule,
    /**
     * Carries the webhook route, and — because Nest instantiates providers
     * eagerly — builds the Stripe client during boot, so a malformed key is a
     * process that refuses to start rather than a 500 the first time a
     * customer taps Pay.
     */
    PaymentsModule,
  ],
})
export class AppModule {}
