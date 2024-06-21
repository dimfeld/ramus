import { EventEmitter } from 'events';
import opentelemetry, { AttributeValue } from '@opentelemetry/api';
import type { AnyInputs, DagNode, DagNodeState } from './types.js';
import { addSpanEvent, runInSpan, runStep, toSpanAttributeValue } from '../tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import { calculateCacheKey, type NodeResultCache } from '../cache.js';
import { Semaphore, acquireSemaphores } from '../semaphore.js';
import { CancelledError } from '../errors.js';
import { NotifyArgs } from '../types.js';
import { uuidv7 } from 'uuidv7';

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
  dagId: string;
  config: DagNode<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>;
  context: CONTEXT;
  /** External input passed when running the DAG */
  rootInput: ROOTINPUT;
  cache?: NodeResultCache;
  chronicle?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  autorun?: () => boolean;
  semaphores?: Semaphore[];
  parentStep: string;
}

export class DagNodeRunner<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS extends AnyInputs,
  OUTPUT,
> extends EventEmitter<{
  state: [{ sourceNode: string; source: string; state: DagNodeState }];
  finish: [{ name: string; output: OUTPUT }];
  'ramus:error': [Error];
  cancelled: [];
  parentError: [];
}> {
  name: string;
  dagName: string;
  dagId: string;
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
  parentStep: string | null;
  step: string | undefined;
  /** A promise which resolves when the node finishes or rejects on an error. */
  _finished: Promise<{ name: string; output: OUTPUT }> | undefined;

  waiting: Set<string>;
  rootInput: ROOTINPUT;
  inputs: Partial<INPUTS>;

  constructor({
    name,
    dagName,
    dagId,
    config,
    context,
    rootInput,
    chronicle,
    cache,
    eventCb,
    autorun,
    semaphores,
    parentStep,
  }: DagNodeRunnerOptions<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>) {
    super();
    this.name = name;
    this.dagId = dagId;
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
    this.parentStep = parentStep;
  }

  get finished() {
    if (!this._finished) {
      // TODO This may need to start out resolved once we can revive a DAG.
      this._finished = new Promise((resolve, reject) => {
        this.once('finish', resolve);
        this.once('cancelled', () => {
          reject(new Error('Cancelled'));
        });
        this.once('ramus:error', reject);
      });
    }
    return this._finished;
  }

  setState(state: DagNodeState) {
    if (this.state === state) {
      return;
    }

    this.getStepNumber();

    this.state = state;
    this.eventCb({
      type: 'dag:node_state',
      data: { state },
      sourceId: this.dagId,
      source: this.dagName,
      sourceNode: this.name,
      step: this.step!,
      meta: this.chronicleOptions?.defaults?.metadata,
      start_time: new Date(),
    });
  }

  /** `init` is called after the constructors have all been run, which is mostly a design
   *  concession to simplify making sure that all the parent node runners have been created first.
   **/
  init(parents: DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, unknown>[]) {
    let parentSpan = opentelemetry.trace.getActiveSpan();
    if (parentSpan) {
      this.parentSpanContext = opentelemetry.trace.setSpan(
        opentelemetry.context.active(),
        parentSpan
      );
    }

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
      parent.once('ramus:error', () => handleParentError(parent.name));
      parent.once('parentError', () => handleParentError(parent.name));
    }
  }

  cancel() {
    if (this.stateReadyToRun() || this.state === 'running') {
      this.setState('cancelled');
    }
  }

  /** Return true if we should try running this node when starting up the runner, either from the start or when
   * reviving the DAG from saved state. */
  readyToResume() {
    return this.waiting.size === 0 && this.stateReadyToRun();
  }

  /** Based only on the state, is this node runnable. This doesn't look at if the node is still waiting for some parent
   * nodes. */
  stateReadyToRun() {
    return this.state === 'waiting' || this.state === 'ready';
  }

  /** Return true if we can run this node. */
  readyToRun() {
    return this.waiting.size === 0 && this.stateReadyToRun();
  }

  getStepNumber() {
    if (typeof this.step === 'number') {
      return;
    }

    this.step = uuidv7();
  }

  async run(triggeredFromParentFinished = false): Promise<boolean> {
    const ready = this.readyToRun();
    if (triggeredFromParentFinished) {
      if (!ready) {
        // Not ready to execute yet
        return false;
      }

      if (!this.autorun()) {
        this.setState('ready');
        return false;
      }
    } else {
      // We were manually told to run, but this node is still waiting for some parent input,
      // or we're currently running, so we can't execute.
      if (!ready && this.state !== 'error') {
        return false;
      }

      this.getStepNumber();
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
    const notify = (e: NotifyArgs) => {
      let start_time = e.start_time || new Date();
      let end_time = e.end_time || start_time;
      this.eventCb({
        type: e.type,
        data: e.data,
        sourceId: this.dagId,
        source: this.name,
        step: this.step!,
        sourceNode: this.dagName,
        meta: chronicleOptions?.defaults?.metadata,
        start_time,
        end_time,
      });
    };

    const parentContext = this.parentSpanContext ?? opentelemetry.context.active();
    const semaphoreKey = this.config.semaphoreKey;

    let semRelease: (() => Promise<void>) | undefined;
    try {
      await runStep(step, this.parentStep, {}, parentContext, async (span) => {
        if (semaphoreKey && this.semaphores?.length) {
          this.setState('pendingSemaphore');
          semRelease = await runInSpan(
            step + 'acquire semaphores',
            { attributes: { semaphoreKey } },
            () => acquireSemaphores(this.semaphores!, semaphoreKey)
          );
        }

        this.setState('running');
        try {
          notify({
            type: 'dag:node_start',
            data: { input: this.inputs, parent_step: this.parentStep },
          });
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
              notify: (e: NotifyArgs, spanEvent = true) => {
                if (spanEvent) {
                  addSpanEvent(span, e);
                }

                notify(e);
              },
              isCancelled: () => this.state === 'cancelled',
              exitIfCancelled: () => {
                if (this.state === 'cancelled') {
                  throw new CancelledError();
                }
              },
            });

            this.cache?.set(this.name, cacheKey, JSON.stringify(output));
          }

          span.setAttribute(
            `dag.node.output.${this.name}`,
            toSpanAttributeValue(output as object | AttributeValue)
          );

          if (this.state !== 'cancelled') {
            notify({ type: 'dag:node_finish', data: { output } });
            this.setState('finished');
            this.result = { type: 'success', output };
            this.emit('finish', { name: this.name, output });
          }
        } catch (e) {
          if (e instanceof CancelledError) {
            // Don't emit an error if we were cancelled
          } else {
            let err = e as Error;
            this.setState('error');
            this.result = { type: 'error', error: err };
            notify({ type: 'dag:node_error', data: { error: err } });
            this.emit('ramus:error', err);

            span.recordException(err);
            span.setAttribute('error', err?.message ?? 'true');
            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          }
        } finally {
          span.setAttribute('dag.node.finishState', this.state);
          span.end();
        }
      });
    } finally {
      semRelease?.();
    }

    // true just indicates that we ran, with no bearing on success or failure
    return true;
  }
}
