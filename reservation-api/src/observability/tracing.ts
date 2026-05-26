/**
 * OpenTelemetry bootstrap — must be imported before any module that issues
 * outbound HTTP or talks to Postgres, so auto-instrumentation can patch the
 * underlying libraries before they're first required. In practice that means
 * this file is the *first* import in `main.ts`.
 *
 * Single SDK, three signals (traces, metrics, logs) → OTLP/HTTP → the
 * Collector (see `docker-compose.yml` observability profile). The Collector
 * fans out to Tempo, Prometheus, and Loki respectively.
 *
 * Disable knob: `OTEL_DISABLED=1` short-circuits start(). Tests don't import
 * main.ts, so they never run this; the OTel API returns no-op
 * tracer/meter/logger when no SDK is registered, which is what the
 * instrumented service code relies on for jest to stay hermetic.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const SERVICE_NAME = 'reservation-api';
const SERVICE_VERSION = process.env.SERVICE_VERSION ?? '1.0.0';

let sdk: NodeSDK | null = null;

export function startTracing(): void {
  if (process.env.OTEL_DISABLED === '1') return;
  if (sdk) return; // idempotent — multiple imports during HMR won't double-init

  // OTLP endpoint defaults to the Collector on localhost:4318. In docker
  // compose the Collector listens on `otel-collector:4318` — set
  // OTEL_EXPORTER_OTLP_ENDPOINT in the service's env to point there.
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${endpoint}/v1/logs` })),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // The fs instrumentation produces an enormous amount of spans for
        // every NestJS file-loader hit at startup — useless noise.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Pino auto-instrumentation injects trace_id/span_id into every log
        // line; we keep it on because Loki uses those fields to derive the
        // Tempo trace link.
        '@opentelemetry/instrumentation-pino': { enabled: true },
      }),
    ],
  });

  sdk.start();
  // Drain on shutdown so the last few spans/metrics/logs from a graceful
  // SIGTERM don't get dropped on the floor.
  const shutdown = () => {
    sdk
      ?.shutdown()
      .catch((err) => console.error('OTel shutdown failed', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Side-effect import: just `import './observability/tracing'` at the top of
// main.ts is enough to enable the SDK.
startTracing();
