import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Env } from './config/env.validation';
import { requestIdMiddleware } from './common/http/request-id';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Assign a correlation id to every request before routing (used by logs + error bodies).
  app.use(requestIdMiddleware);
  // Fire OnApplicationShutdown hooks (drains the DB pool) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  const config: ConfigService<Env, true> = app.get(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}
bootstrap();
