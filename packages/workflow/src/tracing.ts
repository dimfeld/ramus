import { AsyncLocalStorage } from 'node:async_hooks';
import opentelemetry, {
  AttributeValue,
  Span,
  SpanOptions,
  SpanStatusCode,
} from '@opentelemetry/api';
import { NotifyArgs } from './types.js';
import { uuidv7 } from 'uuidv7';
import {
  InternalWorkflowEventCallback,
  WorkflowEvent,
  WorkflowEventArgument,
  WorkflowEventCallback,
} from './events.js';

export const tracer = opentelemetry.trace.getTracer('ramus');

export interface StepOptions {
  name: string;
  tags?: string[];
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
  logEvent: InternalWorkflowEventCallback;
  recordStepInfo?: (o: object) => void;
  getRecordedStepInfo: () => object | undefined;
}

export function getEventContext(): EventContext {
  return (
    asyncEventStorage.getStore() ?? {
      runId: '',
      sourceName: '',
      parentStep: null,
      currentStep: null,
      logEvent: () => {},
      getRecordedStepInfo: () => undefined,
    }
  );
}

/** Options for starting a new run. Many of these options are designed for use when
 * restarting a previous run, as when a state machine was dormant and has received an
 * event. */
export interface RunOptions {
  /** Restore context with this existing run ID */
  runId?: string;
  /** Restore context with this parent step ID */
  parentStep?: string | null;
  /** Restore context with this current step ID */
  currentStep?: string;
  /** A function that will receive events from the run */
  logEvent?: WorkflowEventCallback;
  /** Create a new context, even if we're already in a run. If `forceNewContext` is omitted or `false`,
   * the existing run will be used. */
  forceNewContext?: boolean;
}

/** Run a workflow and initialize an event context, if one does not already exist. */
export function startRun<T>(options: RunOptions, fn: (ctx: EventContext) => T): T {
  let existingContext = options.forceNewContext ? undefined : asyncEventStorage.getStore();
  if (existingContext) {
    return fn(existingContext);
  } else {
    const origLogEvent = options.logEvent;
    const logEvent = origLogEvent
      ? (e: WorkflowEventArgument) => {
          if (!e.runId || !e.step) {
            const eventContext = getEventContext();
            e.runId ||= eventContext.runId;
            e.step ||= eventContext.currentStep ?? undefined;
          }

          origLogEvent(e as WorkflowEvent);
        }
      : () => {};

    let context = {
      runId: options.runId ?? uuidv7(),
      sourceName: '',
      parentStep: options.parentStep ?? null,
      currentStep: options.currentStep ?? null,
      logEvent,
      // We're not in a step yet, so these don't do anything yet.
      recordStepInfo: () => {},
      getRecordedStepInfo: () => undefined,
    };

    return asyncEventStorage.run(context, () => fn(context));
  }
}

/** Run a new step, recording the current step as the step's parent. */
async function runNewStepInternal<T>(
  options: StepOptions,
  span: Span,
  fn: (ctx: EventContext) => Promise<T>
): Promise<T> {
  const { skipLogging, name, tags, info, newSourceName, parentStep, input } = options;
  let oldContext = getEventContext();
  let additionalInfo: object | undefined;
  function recordStepInfo(o: object) {
    additionalInfo = o;
  }

  function getRecordedStepInfo() {
    return additionalInfo;
  }

  let newContext: EventContext = {
    ...oldContext,
    recordStepInfo,
    getRecordedStepInfo,
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
        runId: newContext.runId,
        start_time: startTime,
        data: {
          input,
          tags,
          info: info,
          parent_step: newContext.parentStep,
          span_id: stepSpanId(span),
        },
      });
    }

    try {
      const retVal = await fn(newContext);
      if (!skipLogging) {
        newContext.logEvent({
          type: 'step:end',
          source: newContext.sourceName,
          sourceNode: name,
          runId: newContext.runId,
          step: newContext.currentStep ?? undefined,
          start_time: startTime,
          end_time: new Date(),
          data: {
            info: additionalInfo,
            output: retVal,
          },
        });
      }

      return retVal;
    } catch (e) {
      if (!skipLogging) {
        newContext.logEvent({
          type: 'step:error',
          source: newContext.sourceName,
          sourceNode: name,
          runId: newContext.runId,
          step: newContext.currentStep ?? undefined,
          start_time: startTime,
          end_time: new Date(),
          data: {
            info: additionalInfo,
            output: e,
          },
        });
      }
      throw e;
    }
  });
}

export function stepSpanId(span: Span | undefined) {
  return span?.isRecording() ? span.spanContext().spanId : null;
}

export interface AsStepOptions {
  name?: string;
  tags?: string[];
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

  const tags = options?.tags;
  const info = options?.info;
  return (...args: P) =>
    runStep(
      {
        name,
        tags,
        info,
        input: args.length > 1 ? args : args[0],
      },
      () => fn(...args)
    );
}

/** Record additional information about a step that is only known after running it. */
export function recordStepInfo(info: object) {
  getEventContext()?.recordStepInfo?.(info);
}
