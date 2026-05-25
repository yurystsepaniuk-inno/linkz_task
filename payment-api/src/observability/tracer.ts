/**
 * Manual-span helper. The OTel API returns a no-op tracer when no SDK is
 * registered, so `withSpan` calls are safe in tests (`fn` runs without a
 * span being created) and become real spans once `tracing.ts` has started
 * the SDK.
 */
import { trace, SpanStatusCode, Span, Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('payment-api', '1.0.0');

export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export { tracer };
