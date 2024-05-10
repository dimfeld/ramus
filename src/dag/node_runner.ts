import { EventEmitter } from 'events';
import opentelemetry, { AttributeValue } from '@opentelemetry/api';
import type { AnyInputs, DagNode, DagNodeState } from './types.js';
import { tracer } from '../tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import { calculateCacheKey, type NodeResultCache } from '../cache.js';
import { DagRunner } from './runner.js';
import { Semaphore } from '../semaphore.js';

export class NodeCancelledError extends Error {
  name = 'CancelledError';
}

export interface RunnerSuccessResult<T> {
  type: 'success';
  output: T;
}

export interface RunnerErrorResult {
  type: 'error';
  error: Error;
}

export type RunnerResult<DATA> = RunnerSuccessResult<DATA> | RunnerErrorResult;

export interface DagNodeRunnerOptions<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS extends AnyInputs,
  OUTPUT,
> {
  name: string;
  dagName: string;
  config: DagNode<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>;
  context: CONTEXT;
  /** External input passed when running the DAG */
  rootInput: ROOTINPUT;
  cache?: NodeResultCache;
  chronicle?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  autorun?: () => boolean;
  semaphores?: Semaphore[];
}

export class DagNodeRunner<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS extends AnyInputs,
  OUTPUT,
> extends EventEmitter<{
  state: [{ sourceNode: string; source: string; state: DagNodeState }];
  finish: [{ name: string; output: OUTPUT }];
  error: [Error];
  parentError: [];
}> {
  name: string;
  dagName: string;
  config: DagNode<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>;
  context: CONTEXT;
  state: DagNodeState;
  cache?: NodeResultCache;
  result?: RunnerResult<OUTPUT>;
  parentSpanContext?: opentelemetry.Context;
  chronicleOptions?: ChronicleClientOptions;
  semaphores?: Semaphore[];
  autorun: () => boolean;
  eventCb: WorkflowEventCallback;

  waiting: Set<string>;
  rootInput: ROOTINPUT;
  inputs: Partial<INPUTS>;

  constructor({
    name,
    dagName,
    config,
    context,
    rootInput,
    chronicle,
    cache,
    eventCb,
    autorun,
    semaphores,
  }: DagNodeRunnerOptions<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>) {
    super();
    this.name = name;
    this.dagName = dagName;
    this.config = config;
    this.rootInput = rootInput;
    this.chronicleOptions = chronicle;
    this.cache = cache;
    this.eventCb = eventCb;
    this.autorun = autorun ?? (() => true);
    this.context = context;
    this.state = 'waiting';
    this.semaphores = semaphores;
    this.waiting = new Set();
    this.inputs = {};
  }

  setState(state: DagNodeState) {
    this.state = state;
    this.emit('state', { sourceNode: this.name, source: this.dagName, state });
  }

  /** `init` is called after the constructors have all been run, which is mostly a design
   *  concession to simplify making sure that all the parent node runners have been created first.
   **/
  init(
    parents: DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, unknown>[],
    cancel: EventEmitter<{ cancel: [] }>
  ) {
    let parentSpan = opentelemetry.trace.getActiveSpan();
    if (parentSpan) {
      this.parentSpanContext = opentelemetry.trace.setSpan(
        opentelemetry.context.active(),
        parentSpan
      );
    }

    cancel.on('cancel', () => {
      if (this.state === 'waiting' || this.state === 'running') {
        this.setState('cancelled');
      }
    });

    const handleFinishedParent = (e: { name: string; output: any }) => {
      if (this.state !== 'waiting') {
        return;
      }

      this.waiting.delete(e.name);
      this.inputs[e.name as keyof INPUTS] = e.output;
      this.run(true);
    };

    const handleParentError = (name: string) => {
      if (this.state !== 'waiting') {
        return;
      }

      if (this.config.tolerateParentErrors) {
        handleFinishedParent({ name, output: undefined });
      } else {
        this.setState('cancelled');
        // Pass the error down the chain
        this.emit('parentError');
      }
    };

    for (let parent of parents) {
      this.waiting.add(parent.name);

      parent.once('finish', handleFinishedParent);
      parent.once('error', () => handleParentError(parent.name));
      parent.once('parentError', () => handleParentError(parent.name));
    }
  }

  async run(triggeredFromParentFinished = false): Promise<boolean> {
    if (triggeredFromParentFinished) {
      if (this.waiting.size > 0 || (this.state !== 'waiting' && this.state !== 'ready')) {
        // Not ready to execute yet
        return false;
      }

      if (!this.autorun()) {
        this.setState('ready');
        return false;
      }
    } else {
      // We were manually told to run, but this node is still waiting for some parent input,
      // or we're currently running, so we can't execute yet
      if (this.waiting.size > 0 || this.state === 'running') {
        return false;
      }
    }

    let step = `${this.dagName}:${this.name}`;
    let chronicleOptions: ChronicleClientOptions | undefined;
    if (this.chronicleOptions) {
      chronicleOptions = {
        ...this.chronicleOptions,
        defaults: {
          ...this.chronicleOptions?.defaults,
          metadata: {
            ...this.chronicleOptions?.defaults?.metadata,
            step,
          },
        },
      };
    }

    // This doesn't actually enforce that the `type` and `data` match but it's good enough for the few calls here.
    const sendEvent = (type: string, data: unknown) => {
      this.eventCb({
        type,
        data,
        source: this.name,
        sourceNode: this.dagName,
        meta: chronicleOptions?.defaults?.metadata,
      });
    };

    const semaphoreKey = this.config.semaphoreKey;

    try {
      if (semaphoreKey && this.semaphores?.length) {
        this.setState('pendingSemaphore');
        await Promise.all(this.semaphores.map((s) => s.acquire(semaphoreKey)) ?? []);
      }

      this.setState('running');
      await tracer.startActiveSpan(
        step,
        {},
        this.parentSpanContext ?? opentelemetry.context.active(),
        async (span) => {
          try {
            sendEvent('dag:node_start', { input: this.inputs });
            if (this.config.parents) {
              span.setAttribute('dag.node.parents', this.config.parents.join(', '));
            }

            for (let [k, v] of Object.entries(this.inputs)) {
              span.setAttribute(`dag.node.input.${k}`, toSpanAttributeValue(v));
            }

            let output: OUTPUT;

            const cacheKey = this.cache
              ? calculateCacheKey(this.config.run, this.inputs, this.rootInput)
              : '';
            const cachedValue = await this.cache?.get(this.name, cacheKey);

            if (cachedValue) {
              output = JSON.parse(cachedValue) as OUTPUT;
              span.setAttribute('dag:cache_hit', true);
            } else {
              output = await this.config.run({
                input: this.inputs as INPUTS,
                rootInput: this.rootInput,
                context: this.context,
                span,
                chronicleOptions,
                event: (type, data, spanEvent = true) => {
                  if (spanEvent && data != null && span.isRecording()) {
                    const spanData = Object.fromEntries(
                      Object.entries(data).map(([k, v]) => [k, toSpanAttributeValue(v)])
                    );

                    span.addEvent(type, spanData);
                  }

                  sendEvent(type, data);
                },
                isCancelled: () => this.state === 'cancelled',
                exitIfCancelled: () => {
                  if (this.state === 'cancelled') {
                    throw new NodeCancelledError();
                  }
                },
                runDag: (options) => {
                  let childRunner = new DagRunner({
                    ...options,
                    autorun: this.autorun,
                    eventCb: this.eventCb,
                    chronicle: chronicleOptions,
                  });

                  // Forward state events up to the parent
                  childRunner.on('state', (e) => this.emit('state', e));

                  return childRunner.run();
                },
              });

              this.cache?.set(this.name, cacheKey, JSON.stringify(output));
            }

            span.setAttribute(
              `dag.node.output.${this.name}`,
              toSpanAttributeValue(output as object | AttributeValue)
            );

            if (this.state !== 'cancelled') {
              sendEvent('dag:node_finish', { output });
              this.setState('finished');
              this.result = { type: 'success', output };
              this.emit('finish', { name: this.name, output });
            }
          } catch (e) {
            if (e instanceof NodeCancelledError) {
              // Don't emit an error if we were cancelled
            } else {
              let err = e as Error;
              this.setState('error');
              this.result = { type: 'error', error: e as Error };
              sendEvent('dag:node_error', { error: e });
              this.emit('error', e as Error);

              span.recordException(err);
              span.setAttribute('error', err?.message ?? 'true');
              span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
            }
          } finally {
            span.setAttribute('dag.node.finishState', this.state);
            span.end();
          }
        }
      );
    } finally {
      if (semaphoreKey && this.semaphores) {
        for (let sem of this.semaphores) {
          sem.release(semaphoreKey);
        }
      }
    }

    // true just indicates that we ran, with no bearing on success or failure
    return true;
  }
}

function toSpanAttributeValue(v: AttributeValue | object): AttributeValue {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return JSON.stringify(v);
  } else {
    return v;
  }
}
