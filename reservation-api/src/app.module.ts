import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { trace, context } from '@opentelemetry/api';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './audit/audit.module';
import { SeatsModule } from './seats/seats.module';
import { ReservationsModule } from './reservations/reservations.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { CronModule } from './cron/cron.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // nestjs-pino wires the pino logger into every NestJS `Logger` call and
    // emits structured JSON to stdout — what the Collector tails and ships
    // to Loki. The mixin injects the active OpenTelemetry trace/span ids so
    // a Loki log line can be one-clicked back to its Tempo trace.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // base fields appear on every line — service-name powers Loki's
        // `{service="reservation-api"}` selector.
        base: {
          service: 'reservation-api',
          env: process.env.NODE_ENV ?? 'development',
        },
        formatters: { level: (label) => ({ level: label }) },
        mixin: () => {
          const span = trace.getSpan(context.active());
          if (!span) return {};
          const ctx = span.spanContext();
          return { trace_id: ctx.traceId, span_id: ctx.spanId };
        },
        // Redaction — pino-http's default `req` serializer dumps the *full*
        // headers object on every access-log line. Without this, every line
        // in Loki would carry the Clerk `Authorization: Bearer …`, the
        // service-to-service `x-api-key`, the inbound webhook `x-signature`,
        // and the session `Cookie` / `set-cookie`. We replace each with the
        // literal `[REDACTED]` (keeps the field shape stable for query
        // tooling, removes the secret). The wildcard `*.headers.*` paths
        // catch any other serializer that hands pino a `{headers: {...}}`
        // object (e.g. an axios error logged with `err`).
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
        // Skip access-log emission for health-style requests so the log
        // stream stays signal-dense. Add more paths here as needed.
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
    AuditModule,
    SeatsModule,
    ReservationsModule,
    WebhooksModule,
    CronModule,
  ],
})
export class AppModule {}
