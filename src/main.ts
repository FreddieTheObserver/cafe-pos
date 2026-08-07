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
    /**
     * Keeps the untouched bytes on `req.rawBody` alongside the parsed body.
     * The Stripe webhook signature covers exactly what was sent, so a JSON
     * round-trip — key order, whitespace, number formatting — invalidates it.
     * Set here rather than in `configureApp` because it is a factory option:
     * the parsers have to be built knowing they must keep a copy.
     */
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  const config: ConfigService<Env, true> = app.get(ConfigService);
  configureApp(app, {
    corsOrigins: config.get('CORS_ORIGINS', { infer: true }),
  });

  await app.listen(config.get('PORT', { infer: true }));
}
void bootstrap();
