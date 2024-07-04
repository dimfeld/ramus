import { EventEmitter } from 'events';
import opentelemetry, { AttributeValue } from '@opentelemetry/api';
import type { AnyInputs, DagNode, DagNodeState } from './types.js';
import {
  ChronicleClientOptions,
  RunContext,
  runStep,
  runInSpan,
  toSpanAttributeValue,
} from '@dimfeld/chronicle';
import { calculateCacheKey, type NodeResultCache } from '../cache.js';
import { Semaphore, acquireSemaphores } from '../semaphore.js';
import { CancelledError } from '../errors.js';

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
  'ramus:error': [{ error: Error }];
  cancelled: [];
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
  runContext: RunContext | undefined;
  /** A promise which resolves when the node finishes or rejects on an error. */
  _finished: Promise<{ name: string; output: OUTPUT }> | undefined;

  waiting: Set<string>;
  rootInput: ROOTINPUT;
  inputs: Partial<INPUTS>;

  constructor({
    name,
    dagName,
    config,
    context,
    rootInput,
    cache,
    autorun,
    semaphores,
  }: DagNodeRunnerOptions<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>) {
    super();
    this.name = name;
    this.dagName = dagName;
    this.config = config;
    this.rootInput = rootInput;
    this.cache = cache;
    this.autorun = autorun ?? (() => true);
    this.context = context;
    this.state = 'waiting';
    this.semaphores = semaphores;
    this.waiting = new Set();
    this.inputs = {};
  }

  setRunContext(runContext: RunContext) {
    this.runContext = runContext;
  }

  get finished() {
    if (!this._finished) {
      // TODO This may need to start out resolved once we can revive a DAG.
      this._finished = new Promise((resolve, reject) => {
        this.once('finish', resolve);
        this.once('cancelled', () => {
          reject(new CancelledError());
        });
        this.once('ramus:error', (e) => reject(e.error));
      });
    }
    return this._finished;
  }

  setState(state: DagNodeState) {
    this.state = state;
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
    }

    const parentContext = this.parentSpanContext ?? opentelemetry.context.active();
    const semaphoreKey = this.config.semaphoreKey;

    let semRelease: (() => Promise<void>) | undefined;
    try {
      await runStep(
        {
          name: this.name,
          type: 'dag:node',
          input: {
            input: this.inputs,
            context: this.context,
          },
          tags: this.config.tags,
          info: this.config.info,
          parentRunContext: this.runContext,
          parentSpan: parentContext,
        },
        async (ctx, span) => {
          if (semaphoreKey && this.semaphores?.length) {
            this.setState('pendingSemaphore');
            semRelease = await runInSpan(
              'acquire semaphores',
              { attributes: { semaphoreKey } },
              () => acquireSemaphores(this.semaphores!, semaphoreKey)
            );
          }

          this.setState('running');
          try {
            if (this.config.parents) {
              span.setAttribute('workflow.dag.node.parents', this.config.parents.join(', '));
            }

            for (let [k, v] of Object.entries(this.inputs)) {
              span.setAttribute(`workflow.dag.node.input.${k}`, toSpanAttributeValue(v));
            }

            let output: OUTPUT;

            const cacheKey = this.cache
              ? calculateCacheKey(this.config.run, this.inputs, this.rootInput)
              : '';
            const cachedValue = await this.cache?.get(this.name, cacheKey);

            if (cachedValue) {
              output = JSON.parse(cachedValue) as OUTPUT;
              span.setAttribute('workflow.dag.cache_hit', true);
            } else {
              output = await this.config.run({
                input: this.inputs as INPUTS,
                rootInput: this.rootInput,
                context: this.context,
                span,
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
              `workflow.dag.node.output.${this.name}`,
              toSpanAttributeValue(output as object | AttributeValue)
            );

            if (this.state !== 'cancelled') {
              this.setState('finished');
              this.result = { type: 'success', output };
              this.emit('finish', { name: this.name, output });
            }
          } catch (e) {
            if (e instanceof CancelledError) {
              // Don't emit an error if we were cancelled
              ctx.recordStepInfo({ cancelled: true });
            } else {
              let err = e as Error;
              this.setState('error');
              this.result = { type: 'error', error: err };
              this.emit('ramus:error', { error: err });
              throw e;
            }
          } finally {
            span.setAttribute('workflow.dag.node.finishState', this.state);
          }
        }
      );
    } catch (e) {
      // Ignore the error here since we handled it above, and just re-raised it so that
      // runStep would log it properly.
    } finally {
      semRelease?.();
    }

    // true just indicates that we ran, with no bearing on success or failure
    return true;
  }
}
