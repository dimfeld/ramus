import { EventEmitter } from 'events';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import type { AnyInputs, Dag, DagNodeState } from './types.js';
import { CompiledDag } from './compile.js';
import { DagNodeRunner } from './node_runner.js';
import { runInSpan } from '../tracing.js';
import { NodeResultCache } from '../cache.js';
import { Semaphore } from '../semaphore.js';
import { Runnable, RunnableEvents } from '../runnable.js';

export interface DagRunnerOptions<CONTEXT extends object, ROOTINPUT, OUTPUT = unknown> {
  name?: string;
  dag: Dag<CONTEXT, ROOTINPUT> | CompiledDag<CONTEXT, ROOTINPUT, OUTPUT>;
  input: ROOTINPUT;
  cache?: NodeResultCache;
  context?: CONTEXT;
  /** Semaphores which can be used to rate limit operations by the DAG. This accepts multiple Semaphores, which
   * can be used to provide a semaphore for global operations and another one for this particular DAG, for example. */
  semaphores?: Semaphore[];
  /** Options for a Chronicle LLM proxy client */
  chronicle?: ChronicleClientOptions;
  /** A function that can take events from the running DAG */
  eventCb?: WorkflowEventCallback;
  /** A function that returns if the DAG should run nodes whenever they become ready, or wait for an external source to
   * run them. */
  autorun?: () => boolean;
}

function noop() {}

type DagRunnerEvents<OUTPUT> = {
  'dag:state': [{ sourceNode: string; source: string; state: DagNodeState }];
} & RunnableEvents<OUTPUT>;

export class DagRunner<CONTEXT extends object, ROOTINPUT, OUTPUT>
  extends EventEmitter<DagRunnerEvents<OUTPUT>>
  implements Runnable<OUTPUT, DagRunnerEvents<OUTPUT>>
{
  name: string;
  context?: CONTEXT;
  runners: Map<string, DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, any>>;
  outputNode: DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, OUTPUT>;
  tolerateFailures: boolean;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  autorun: () => boolean;
  input: ROOTINPUT;
  output: OUTPUT | undefined;
  /* A promise which resolves when the entire DAG finishes or rejects on an error. */
  _finished: Promise<OUTPUT> | undefined;

  constructor({
    name,
    dag,
    context,
    input,
    chronicle,
    eventCb,
    cache,
    autorun,
    semaphores,
  }: DagRunnerOptions<CONTEXT, ROOTINPUT, OUTPUT>) {
    super();
    if (!(dag instanceof CompiledDag)) {
      dag = new CompiledDag(dag);
    }

    this.context = context;
    this.input = input;

    this.chronicleOptions = chronicle;
    this.eventCb = eventCb ?? noop;

    const { runners, outputNode } = dag.buildRunners({
      context,
      input,
      chronicle,
      eventCb: this.eventCb,
      cache,
      autorun,
      semaphores,
    });

    this.name = name ? `${name}: ${dag.config.name}` : dag.config.name;
    this.tolerateFailures = dag.config.tolerateFailures ?? false;
    this.runners = runners;
    this.outputNode = outputNode;
    this.autorun = autorun ?? (() => true);
  }

  get finished() {
    if (!this._finished) {
      // TODO Check for if we're already resolved or errored
      this._finished = new Promise((resolve, reject) => {
        this.once('finish', resolve);
        this.once('cancelled', () => {
          reject(new Error('Cancelled'));
        });
        this.once('error', reject);
      });
    }

    return this._finished;
  }

  /** Run the entire DAG to completion */
  run(): Promise<void> {
    return runInSpan(`DAG ${this.name}`, {}, async (span) => {
      this.eventCb({
        data: { input: this.input },
        source: this.name,
        sourceNode: '',
        type: 'dag:start',
        meta: this.chronicleOptions?.defaults?.metadata,
      });

      for (let runner of this.runners.values()) {
        if (!this.tolerateFailures) {
          runner.on('error', (e) => {
            this.eventCb({
              data: { error: e },
              source: this.name,
              sourceNode: '',
              type: 'dag:error',
              meta: this.chronicleOptions?.defaults?.metadata,
            });
            // Make sure to emit error before we cancel, so that anything listening to both will know about the
            // error first.
            this.emit('error', e);
            this.cancel(false);
          });
        }
      }

      this.outputNode.on('error', (e) => {
        this.cancel(false);
        this.emit('error', e);
      });

      this.outputNode.on('finish', (e) => {
        this.eventCb({
          data: { output: e.output },
          source: this.name,
          sourceNode: '',
          type: 'dag:finish',
          meta: this.chronicleOptions?.defaults?.metadata,
        });

        this.output = e.output;
        this.emit('finish', e.output);
      });

      if (this.autorun()) {
        for (let runner of this.runners.values()) {
          if (runner.readyToResume()) {
            runner.run();
          }
        }
      }
    });
  }

  cancel(emit = true) {
    for (let runner of this.runners.values()) {
      runner.cancel();
    }

    if (emit) {
      this.emit('cancelled');
    }
  }
}

/** Create a run a DAG in one statement, for simple cases.*/
export async function runDag<CONTEXT extends object, INPUT, OUTPUT>(
  options: DagRunnerOptions<CONTEXT, INPUT, OUTPUT>
) {
  let runner = new DagRunner(options);
  runner.run();
  return runner.finished;
}
