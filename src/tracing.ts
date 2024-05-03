import opentelemetry, { Span, SpanStatusCode } from '@opentelemetry/api';

export const tracer = opentelemetry.trace.getTracer('orchard');

/** Run a function in a span, and record errors if they occur */
export async function runInSpan<T>(spanName: string, f: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      let value = await f(span);
      span.end();
      return value;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    }
  });
}
