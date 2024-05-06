import { EventEmitter } from 'events';
import opentelemetry from '@opentelemetry/api';
import type { AnyInputs, DagNode, DagNodeState } from './types.js';
import { tracer } from '../tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';

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
  config: DagNode<CONTEXT, INPUTS, OUTPUT>;
  context: CONTEXT;
  state: DagNodeState;
  result?: RunnerResult<OUTPUT>;
  parentSpanContext?: opentelemetry.Context;
  spanName: string;

  waiting: Set<string>;
  inputs: Partial<INPUTS>;

  constructor(
    name: string,
    spanName: string,
    config: DagNode<CONTEXT, INPUTS, OUTPUT>,
    context: CONTEXT
  ) {
    super();
    this.name = name;
    this.spanName = spanName;
    this.config = config;
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

    await tracer.startActiveSpan(
      this.spanName,
      {},
      this.parentSpanContext ?? opentelemetry.context.active(),
      async (span) => {
        try {
          if (this.config.parents) {
            span.setAttribute('dag.node.parents', this.config.parents.join(', '));
          }
          this.state = 'running';

          let output = await this.config.run({
            context: this.context,
            span,
            isCancelled: () => this.state === 'cancelled',
            exitIfCancelled: () => {
              if (this.state === 'cancelled') {
                throw new NodeCancelledError();
              }
            },
            input: this.inputs as INPUTS,
          });

          if (this.state === 'running') {
            span.setAttribute('finishState', 'cancelled');

            this.state = 'finished';
            this.result = { type: 'success', output };
            this.emit('finish', { name: this.name, output });
          }
        } catch (e) {
          if (e instanceof NodeCancelledError) {
            // Don't emit an error if we were cancelled
            span.setAttribute('finishState', 'cancelled');
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
          span.end();
        }
      }
    );

    // true just indicates that we ran, with no bearing on success or failure
    return true;
  }
}
