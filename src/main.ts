import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { Env } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // bufferLogs holds startup logs until the pino logger is installed below.
    bufferLogs: true,
    // configureApp registers the only JSON body parser, with our size limit.
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));

  const config: ConfigService<Env, true> = app.get(ConfigService);
  configureApp(app, {
    corsOrigins: config.get('CORS_ORIGINS', { infer: true }),
  });

  await app.listen(config.get('PORT', { infer: true }));
}
void bootstrap();
