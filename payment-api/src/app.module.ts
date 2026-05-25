import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { trace, context } from '@opentelemetry/api';
import { DatabaseModule } from './database/database.module';
import { CheckoutModule } from './checkout/checkout.module';
import { RefundsModule } from './refunds/refunds.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // See reservation-api's app.module for the rationale; duplicated rather
    // than shared so each service stays self-contained.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        base: {
          service: 'payment-api',
          env: process.env.NODE_ENV ?? 'development',
        },
        formatters: { level: (label) => ({ level: label }) },
        mixin: () => {
          const span = trace.getSpan(context.active());
          if (!span) return {};
          const ctx = span.spanContext();
          return { trace_id: ctx.traceId, span_id: ctx.spanId };
        },
        // Redaction — see reservation-api/app.module.ts for the rationale.
        // payment-api also receives the `x-api-key` service-to-service header
        // and sends webhooks signed with `x-signature`; both must be censored
        // before any access log hits Loki.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers["x-signature"]',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            '*.headers.authorization',
            '*.headers["x-api-key"]',
            '*.headers["x-signature"]',
            '*.headers.cookie',
            '*.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
        autoLogging: { ignore: (req) => req.url === '/health' },
        transport:
          process.env.PINO_PRETTY === '1'
            ? {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
              }
            : undefined,
      },
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    HealthModule,
    CheckoutModule,
    RefundsModule,
  ],
})
export class AppModule {}
