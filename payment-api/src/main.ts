// MUST be the first import — see tracing.ts for why.
import './observability/tracing';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger, LoggerModule } from 'nestjs-pino';
import { AppModule } from './app.module';
import { appLogger } from './observability/logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const port = parseInt(config.getOrThrow<string>('PORT'), 10);
  const corsOrigin = config.getOrThrow<string>('CORS_ORIGIN');

  app.enableCors({ origin: corsOrigin });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.listen(port);
  appLogger.info({ port }, `payment-api running on port ${port}`);
}

void LoggerModule;
bootstrap().catch((err) => {
  appLogger.fatal({ err }, 'payment-api failed to start');
  process.exit(1);
});
