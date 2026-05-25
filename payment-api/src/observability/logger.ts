/**
 * Structured logging for payment-api. Same shape as reservation-api's
 * `logger.ts` — kept duplicated rather than factored into a shared lib so
 * each service owns its own base attributes (`service` field) and the two
 * package.json's stay self-contained.
 *
 * Pino emits JSON to stdout; the Collector ships it to Loki. Every line
 * carries the active span's `trace_id` + `span_id` (when one is open) so
 * Loki can derive a one-click Tempo link.
 */
import pino, { LoggerOptions } from 'pino';
import { trace, context } from '@opentelemetry/api';

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'payment-api',
    env: process.env.NODE_ENV ?? 'development',
  },
  formatters: { level: (label) => ({ level: label }) },
  // Censor secret-bearing headers before they reach Loki. Mirrors the redact
  // config in app.module.ts's pinoHttp options.
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
  mixin: () => {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const ctx = span.spanContext();
    return { trace_id: ctx.traceId, span_id: ctx.spanId };
  },
};

const prettyTransport: LoggerOptions['transport'] | undefined =
  process.env.PINO_PRETTY === '1'
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      }
    : undefined;

export const appLogger = pino({
  ...baseOptions,
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});
