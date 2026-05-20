import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);

  const port = parseInt(config.getOrThrow<string>('PORT'), 10);
  const corsOrigin = config.getOrThrow<string>('CORS_ORIGIN');

  app.enableCors({ origin: corsOrigin });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.listen(port);
  console.log(`reservation-api running on port ${port}`);
}
bootstrap();
