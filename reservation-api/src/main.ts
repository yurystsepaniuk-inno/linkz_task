// MUST be the first import: starts the OpenTelemetry NodeSDK before NestJS
// (and via it, `pg`, `http`, Express) is loaded, so auto-instrumentation can
// patch those modules in time. Moving any other import above this line will
// silently disable a chunk of the auto-instrumentation.
import './observability/tracing';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger, LoggerModule } from 'nestjs-pino';
import { AppModule } from './app.module';
import { appLogger } from './observability/logger';

async function bootstrap() {
  // bufferLogs: true buffers messages emitted during DI bootstrap so they're
  // flushed through the swapped logger below — without it, the very first
  // log lines would still go through the default NestJS console logger and
  // miss the trace_id/service tags Loki expects.
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const port = parseInt(config.getOrThrow<string>('PORT'), 10);
  const corsOrigin = config.getOrThrow<string>('CORS_ORIGIN');

  app.enableCors({ origin: corsOrigin });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.listen(port);
  appLogger.info({ port }, `reservation-api running on port ${port}`);
}

// Reference LoggerModule so tsc keeps the side-effect import — the module is
// imported in AppModule, this is belt-and-braces against tree-shaking that
// might prune the unused symbol here.
void LoggerModule;
bootstrap().catch((err) => {
  appLogger.fatal({ err }, 'reservation-api failed to start');
  process.exit(1);
});
