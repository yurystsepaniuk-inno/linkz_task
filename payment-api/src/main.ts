// MUST be the first import — see tracing.ts for why.
import './observability/tracing';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger, LoggerModule } from 'nestjs-pino';
import { AppModule } from './app.module';
import { appLogger } from './observability/logger';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const port = parseInt(config.getOrThrow<string>('PORT'), 10);
  const corsOrigin = config.getOrThrow<string>('CORS_ORIGIN');

  // PollRateLimitGuard keys off `req.ip`. Behind a proxy (ALB, nginx, k8s
  // ingress) without this, every request looks like it came from the proxy
  // and a single noisy client gets the whole bucket. Accepts Express'
  // `trust proxy` syntax: `1` (first hop), `loopback`, a CIDR list, etc.
  // Opt-in: only set TRUST_PROXY when the deployment actually fronts the
  // service with a proxy, otherwise spoofed X-Forwarded-For headers would
  // let any client choose their own bucket.
  const trustProxy = config.get<string>('TRUST_PROXY');
  if (trustProxy) app.set('trust proxy', trustProxy);

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
