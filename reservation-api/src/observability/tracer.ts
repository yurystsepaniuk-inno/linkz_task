/**
 * Manual-span helper. The OTel API returns a no-op tracer when no SDK is
 * registered — so calls into `withSpan` are safe in tests (they just execute
 * `fn` with no span created), and become real spans once `tracing.ts` has
 * started the SDK.
 *
 * Usage:
 *   await withSpan('reservation.create', { 'seat.id': dto.seatId }, async (span) => {
 *     // ... work; throw → span recorded as ERROR; record events with span.addEvent()
 *   });
 */
import { trace, SpanStatusCode, Span, Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('reservation-api', '1.0.0');

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
