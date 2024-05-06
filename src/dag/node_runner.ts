import { EventEmitter } from 'events';
import opentelemetry from '@opentelemetry/api';
import type { AnyInputs, DagNode, DagNodeState } from './types.js';
import { tracer } from '../tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import { runDag } from './runner.js';

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

export interface DagNodeRunnerOptions<CONTEXT extends object, INPUTS extends AnyInputs, OUTPUT> {
  name: string;
  dagName: string;
  config: DagNode<CONTEXT, INPUTS, OUTPUT>;
  context: CONTEXT;
  chronicle?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback<unknown>;
}

export class DagNodeRunner<
  CONTEXT extends object,
  INPUTS extends AnyInputs,
  OUTPUT,
> extends EventEmitter<{
  finish: [{ name: string; output: OUTPUT }];
  error: [Error];
  parentError: [];
}> {
  name: string;
  dagName: string;
  config: DagNode<CONTEXT, INPUTS, OUTPUT>;
  context: CONTEXT;
  state: DagNodeState;
  result?: RunnerResult<OUTPUT>;
  parentSpanContext?: opentelemetry.Context;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback<unknown>;

  waiting: Set<string>;
  inputs: Partial<INPUTS>;

  constructor({
    name,
    dagName,
    config,
    context,
    chronicle,
    eventCb,
  }: DagNodeRunnerOptions<CONTEXT, INPUTS, OUTPUT>) {
    super();
    this.name = name;
    this.dagName = dagName;
    this.config = config;
    this.chronicleOptions = chronicle;
    this.eventCb = eventCb;
    this.context = context;
    this.state = 'waiting';
    this.waiting = new Set();
    this.inputs = {};
  }

  /** `init` is called after the constructors have all been run, which is mostly a design
   *  concession to simplify making sure that all the parent node runners have been created first.
   **/
  init(
    parents: DagNodeRunner<CONTEXT, AnyInputs, unknown>[],
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
        this.state = 'cancelled';
      }
    });

    const handleFinishedParent = (e: { name: string; output: any }) => {
      if (this.state !== 'waiting') {
        return;
      }

      this.waiting.delete(e.name);
      this.inputs[e.name as keyof INPUTS] = e.output;
      this.run();
    };

    const handleParentError = (name: string) => {
      if (this.state !== 'waiting') {
        return;
      }

      if (this.config.tolerateParentErrors) {
        handleFinishedParent({ name, output: undefined });
      } else {
        this.state = 'cancelled';
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

  async run(): Promise<boolean> {
    if (this.waiting.size > 0 || this.state !== 'waiting') {
      // Not ready to execute yet
      return false;
    }

    this.state = 'running';
    let step = `${this.dagName}:${this.name}`;
    await tracer.startActiveSpan(
      step,
      {},
      this.parentSpanContext ?? opentelemetry.context.active(),
      async (span) => {
        try {
          if (this.config.parents) {
            span.setAttribute('dag.node.parents', this.config.parents.join(', '));
          }

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

          let output = await this.config.run({
            input: this.inputs as INPUTS,
            context: this.context,
            span,
            chronicleOptions,
            event: (type, data) =>
              this.eventCb({
                type,
                data,
                meta: chronicleOptions?.defaults?.metadata,
                source: this.dagName,
                sourceNode: this.name,
              }),
            isCancelled: () => this.state === 'cancelled',
            exitIfCancelled: () => {
              if (this.state === 'cancelled') {
                throw new NodeCancelledError();
              }
            },
            runDag: (options) =>
              runDag({ ...options, eventCb: this.eventCb, chronicle: chronicleOptions }),
          });

          if (this.state !== 'cancelled') {
            this.state = 'finished';
            this.result = { type: 'success', output };
            this.emit('finish', { name: this.name, output });
          }
        } catch (e) {
          if (e instanceof NodeCancelledError) {
            // Don't emit an error if we were cancelled
          } else {
            let err = e as Error;
            this.state = 'error';
            this.result = { type: 'error', error: e as Error };
            this.emit('error', e as Error);

            span.recordException(err);
            span.setAttribute('error', err?.message ?? 'true');
            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          }
        } finally {
          span.setAttribute('finishState', this.state);
          span.end();
        }
      }
    );

    // true just indicates that we ran, with no bearing on success or failure
    return true;
  }
}
