import { AsyncLocalStorage } from 'node:async_hooks';
import opentelemetry, {
  AttributeValue,
  Span,
  SpanOptions,
  SpanStatusCode,
} from '@opentelemetry/api';
import { NotifyArgs } from './types.js';
import { uuidv7 } from 'uuidv7';
import { WorkflowEvent, WorkflowEventCallback } from './events.js';

export const tracer = opentelemetry.trace.getTracer('ramus');

export interface StepOptions {
  name: string;
  type?: string;
  info?: object;
  spanOptions?: SpanOptions;
  /** Override the parent step */
  parentStep?: string | null;
  /** Override the parent span */
  parentSpan?: opentelemetry.Context;
  /** If true, skip logging the step since it's being done manually. */
  skipLogging?: boolean;
  newSourceName?: string;
  input?: unknown;
}

/** Run a step of a workflow. This both adds a tracing span and starts a new step in the
 * workflow's event tracking. */
export function runStep<T>(options: StepOptions, f: (span: Span, ctx: EventContext) => Promise<T>) {
  let spanOptions: SpanOptions = options.spanOptions ?? {};
  if (options.info) {
    spanOptions.attributes = {
      ...spanOptions.attributes,
      ...Object.fromEntries(
        Object.entries(options.info).map(([k, v]) => [k, toSpanAttributeValue(v)])
      ),
    };
  }

  return runInSpanWithParent(options.name, spanOptions, options.parentSpan, (span) => {
    return runNewStepInternal(options, span, (ctx) => f(span, ctx));
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
  runId: string;
  sourceName: string;
  parentStep: string | null;
  currentStep: string | null;
  logEvent: WorkflowEventCallback;
}

export function getEventContext(): EventContext {
  return (
    asyncEventStorage.getStore() ?? {
      runId: uuidv7(),
      sourceName: '',
      parentStep: null,
      currentStep: null,
      logEvent: () => {},
    }
  );
}

export interface RunWithEventContextOptions {
  /** An existing run ID */
  runId?: string;
  sourceName?: string;
  /** Use this parent step */
  parentStep?: string | null;
  /** Initialize with this step number instead of 0. */
  currentStep?: string;
  logEvent?: WorkflowEventCallback;
  /** Create a new context, even if we're already in one. */
  forceNewContext?: boolean;
}

/** Run a workflow and initialize an event context, if one does not already exist. */
export function runWithEventContext<T>(options: RunWithEventContextOptions, fn: () => T): T {
  let existingContext = options.forceNewContext ? undefined : asyncEventStorage.getStore();
  if (existingContext) {
    return fn();
  } else {
    let context = {
      runId: options.runId ?? uuidv7(),
      sourceName: options.sourceName ?? '',
      parentStep: options.parentStep ?? null,
      currentStep: options.currentStep ?? null,
      logEvent: options.logEvent ?? (() => {}),
    };

    return asyncEventStorage.run(context, fn);
  }
}

/** Run a new step, recording the current step as the step's parent. */
async function runNewStepInternal<T>(
  options: StepOptions,
  span: Span,
  fn: (ctx: EventContext) => Promise<T>
): Promise<T> {
  const { skipLogging, name, type, info, newSourceName, parentStep, input } = options;
  let oldContext = getEventContext();
  let newContext: EventContext = {
    ...oldContext,
    sourceName: newSourceName ?? oldContext.sourceName,
    parentStep: parentStep ?? oldContext.currentStep,
    currentStep: uuidv7(),
  };

  return asyncEventStorage.run(newContext, async () => {
    let startTime = new Date();
    if (!skipLogging) {
      newContext.logEvent({
        type: 'step:start',
        source: newContext.sourceName,
        sourceNode: name,
        step: newContext.currentStep ?? undefined,
        sourceId: newContext.runId,
        start_time: startTime,
        data: {
          input,
          step_type: type ?? 'step',
          info: info,
          parent_step: newContext.parentStep,
          span_id: stepSpanId(span),
        },
      });
    }

    const retVal = await fn(newContext);

    if (!skipLogging) {
      newContext.logEvent({
        type: 'step:end',
        source: newContext.sourceName,
        sourceNode: name,
        sourceId: newContext.runId,
        step: newContext.currentStep ?? undefined,
        start_time: startTime,
        end_time: new Date(),
        data: {
          output: retVal,
        },
      });
    }

    return retVal;
  });
}

export function stepSpanId(span: Span | undefined) {
  return span?.isRecording() ? span.spanContext().spanId : null;
}

export interface AsStepOptions {
  name?: string;
  type?: string;
  info?: object;
}

/** Wrap a function so that it runs as a step.
 *
 *  export const doIt = asStep(async doIt(input) => {
 *    await callModel(input)
 *  })
 * */
export function asStep<P extends unknown[] = unknown[], RET = unknown>(
  fn: (...args: P) => Promise<RET>,
  options?: AsStepOptions
): (...args: P) => Promise<RET> {
  const name = options?.name ?? fn.name;

  if (!name) {
    throw new Error(
      `Step has no name. You may need to declare your function differently or explicitly provide a name`
    );
  }

  const type = options?.type;
  const info = options?.info;
  return (...args: P) =>
    runStep(
      {
        name,
        type,
        info,
        input: args.length > 1 ? args : args[0],
      },
      () => fn(...args)
    );
}
