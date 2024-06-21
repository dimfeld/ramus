import { AsyncLocalStorage } from 'node:async_hooks';
import opentelemetry, {
  AttributeValue,
  Span,
  SpanOptions,
  SpanStatusCode,
} from '@opentelemetry/api';
import { NotifyArgs } from './types.js';

export const tracer = opentelemetry.trace.getTracer('ramus');

/** Run a step of a workflow. This both adds a tracing span and sets up the step counters
 * for the workflow. */
export function runStep<T>(
  spanName: string,
  parentStep: number | null,
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
  parentStep: number | null;
  currentStep: number | null;
  stepCounter: StepCounter;
}

export function getEventContext(): EventContext {
  return (
    asyncEventStorage.getStore() ?? {
      stepCounter: new StepCounter(0),
      parentStep: null,
      currentStep: null,
    }
  );
}

export interface RunWithEventContextOptions<T> {
  /** Use this parent step */
  parentStep?: number | null;
  /** Initialize with this step number instead of 0. */
  currentStep?: number;
  /** The old value from the StepCounter, if restoring this context. */
  stepCounterValue?: number;
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
      stepCounter: new StepCounter(
        options.stepCounterValue ?? options.currentStep ?? options.parentStep ?? 0
      ),
      parentStep: options.parentStep ?? null,
      currentStep: options.currentStep ?? null,
    };

    return asyncEventStorage.run(context, options.fn);
  }
}

/** Run a new step, recording the current step as the step's parent. */
function runNewStepInternal<T>(parentStep: number | null, fn: () => T): T {
  let currentContext = getEventContext();
  let newContext = {
    ...currentContext,
    parentStep,
    currentStep: currentContext.stepCounter.next(),
  };

  return asyncEventStorage.run(newContext, fn);
}

export class StepCounter {
  count: number;

  constructor(initial: number) {
    this.count = initial;
  }

  next() {
    return this.count++;
  }
}
