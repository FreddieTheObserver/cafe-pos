import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { Env } from './config/env.validation';

async function bootstrap() {
  // bufferLogs holds startup logs until the pino logger is installed below.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Fire OnApplicationShutdown hooks (drains the DB pool) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  const config: ConfigService<Env, true> = app.get(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}
void bootstrap();
