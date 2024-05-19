import opentelemetry, {
  AttributeValue,
  Attributes,
  Span,
  SpanOptions,
  SpanStatusCode,
} from '@opentelemetry/api';

export const tracer = opentelemetry.trace.getTracer('ramus');

/** Run a function in a span, and record errors if they occur */
export async function runInSpanWithParent<T>(
  spanName: string,
  options: SpanOptions,
  parent: opentelemetry.Context | undefined,
  f: (span: Span) => Promise<T>
): Promise<T> {
  parent ??= opentelemetry.context.active();
  return tracer.startActiveSpan(spanName, options, parent, async (span) => {
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

/** Run a function in a span, and record errors if they occur */
export async function runInSpan<T>(
  spanName: string,
  options: SpanOptions,
  f: (span: Span) => Promise<T>
): Promise<T> {
  return runInSpanWithParent(spanName, options, undefined, f);
}

export function addSpanEvent(span: Span, type: string, data?: unknown) {
  if (span.isRecording()) {
    const spanData = Object.fromEntries(
      Object.entries(data ?? {}).map(([k, v]) => [k, toSpanAttributeValue(v)])
    );

    span.addEvent(type, spanData);
  }
}

export function toSpanAttributeValue(v: AttributeValue | object): AttributeValue {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return JSON.stringify(v);
  } else {
    return v;
  }
}
