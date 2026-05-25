/**
 * Structured logging for reservation-api.
 *
 * Pino emits JSON to stdout; the Collector tails docker logs via its
 * filelog/journald receivers and ships them to Loki. Every line carries the
 * active span's `trace_id` + `span_id` (when one is open), so a Grafana log
 * panel can derive a one-click link back to Tempo for the same request.
 *
 * The trace/span fields are injected by a pino mixin (rather than relying on
 * `@opentelemetry/instrumentation-pino`'s require-time patch) so the fields
 * are present even when the OTel SDK is disabled but a caller has set a
 * manual span context — keeps the structure stable for log queries.
 *
 * `pino-pretty` output for `PINO_PRETTY=1` (local dev). Production gets the
 * raw JSON line, which is what Loki wants.
 */
import pino, { LoggerOptions } from 'pino';
import { trace, context } from '@opentelemetry/api';

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'reservation-api',
    env: process.env.NODE_ENV ?? 'development',
  },
  formatters: {
    // Use the conventional `level: "info"` label rather than the numeric
    // 30 — Loki queries are easier to read.
    level: (label) => ({ level: label }),
  },
  // Censor secret-bearing headers before they reach Loki. Mirrors the redact
  // config in app.module.ts's pinoHttp options — same paths so a fact logged
  // through the access-log pipeline and a fact logged through the standalone
  // appLogger get the same treatment.
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
