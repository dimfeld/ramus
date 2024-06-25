import { AsyncLocalStorage } from 'node:async_hooks';
import opentelemetry, {
  AttributeValue,
  Span,
  SpanOptions,
  SpanStatusCode,
} from '@opentelemetry/api';
import { NotifyArgs } from './types.js';
import { uuidv7 } from 'uuidv7';

export const tracer = opentelemetry.trace.getTracer('ramus');

/** Run a step of a workflow. This both adds a tracing span and sets up the step counters
 * for the workflow. */
export function runStep<T>(
  spanName: string,
  parentStep: string | null,
  options: SpanOptions,
  parentSpan: opentelemetry.Context | undefined,
  f: (span: Span) => Promise<T>
) {
  return runInSpanWithParent(spanName, options, parentSpan, (span) => {
    return runNewStepInternal(parentStep, () => {
      return f(span);
    });
  });
}

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

export function addSpanEvent(span: Span, e: NotifyArgs) {
  if (span.isRecording()) {
    const spanData = Object.fromEntries(
      Object.entries(e.data ?? {}).map(([k, v]) => [k, toSpanAttributeValue(v)])
    );

    span.addEvent(e.type, spanData);
  }
}

export function toSpanAttributeValue(v: AttributeValue | object): AttributeValue {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return JSON.stringify(v);
  } else {
    return v;
  }
}

export const asyncEventStorage = new AsyncLocalStorage<EventContext>();

export interface EventContext {
  parentStep: string | null;
  currentStep: string | null;
}

export function getEventContext(): EventContext {
  return (
    asyncEventStorage.getStore() ?? {
      parentStep: null,
      currentStep: null,
    }
  );
}

export interface RunWithEventContextOptions<T> {
  /** Use this parent step */
  parentStep?: string | null;
  /** Initialize with this step number instead of 0. */
  currentStep?: string;
  /** Create a new context, even if we're already in one. */
  forceNewContext?: boolean;
  /** The function to run. */
  fn: () => T;
}

/** Run a workflow and initialize an event context, if one does not already exist. */
export function runWithEventContext<T>(options: RunWithEventContextOptions<T>): T {
  let existingContext = options.forceNewContext ? undefined : asyncEventStorage.getStore();
  if (existingContext) {
    return options.fn();
  } else {
    let context = {
      parentStep: options.parentStep ?? null,
      currentStep: options.currentStep ?? null,
    };

    return asyncEventStorage.run(context, options.fn);
  }
}

/** Run a new step, recording the current step as the step's parent. */
function runNewStepInternal<T>(parentStep: string | null, fn: () => T): T {
  let currentContext = getEventContext();
  let newContext = {
    ...currentContext,
    parentStep,
    currentStep: uuidv7(),
  };

  return asyncEventStorage.run(newContext, fn);
}

export function stepSpanId(span: Span | undefined) {
  return span?.isRecording() ? span.spanContext().spanId : null;
}
