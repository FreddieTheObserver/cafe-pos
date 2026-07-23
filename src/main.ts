import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Env } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Fire OnApplicationShutdown hooks (drains the DB pool) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  const config: ConfigService<Env, true> = app.get(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}
bootstrap();
