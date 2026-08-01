import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { CatalogModule } from './catalog/catalog.module';
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
    DatabaseModule,
    RedisModule,
    CommonModule,
    HealthModule,
    IdentityModule,
    CatalogModule,
  ],
})
export class AppModule {}
