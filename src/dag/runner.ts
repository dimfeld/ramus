import { EventEmitter } from 'events';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import type { AnyInputs, Dag, DagNodeState } from './types.js';
import { CompiledDag } from './compile.js';
import { DagNodeRunner } from './node_runner.js';
import { runInSpan } from '../tracing.js';
import { NodeResultCache } from '../cache.js';

export interface DagRunnerOptions<CONTEXT extends object, ROOTINPUT, OUTPUT = unknown> {
  dag: Dag<CONTEXT, ROOTINPUT> | CompiledDag<CONTEXT, ROOTINPUT, OUTPUT>;
  input: ROOTINPUT;
  cache?: NodeResultCache;
  context?: CONTEXT;
  /** Options for a Chronicle LLM proxy client */
  chronicle?: ChronicleClientOptions;
  /** A function that can take events from the running DAG */
  eventCb?: WorkflowEventCallback;
  /** A function that returns if the DAG should run nodes whenever they become ready, or wait for an external source to
   * run them. */
  autorun?: () => boolean;
}

function noop() {}

export class DagRunner<CONTEXT extends object, ROOTINPUT, OUTPUT> extends EventEmitter<{
  state: [{ sourceNode: string; source: string; state: DagNodeState }];
}> {
  name: string;
  context?: CONTEXT;
  runners: DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, unknown>[];
  outputNode: DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, OUTPUT>;
  tolerateFailures: boolean;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  autorun: () => boolean;
  input: ROOTINPUT;

  cancel: EventEmitter<{ cancel: [] }>;

  constructor({
    dag,
    context,
    input,
    chronicle,
    eventCb,
    cache,
    autorun,
  }: DagRunnerOptions<CONTEXT, ROOTINPUT, OUTPUT>) {
    super();
    if (!(dag instanceof CompiledDag)) {
      dag = new CompiledDag(dag);
    }

    this.context = context;
    this.input = input;

    this.chronicleOptions = chronicle;
    this.eventCb = eventCb ?? noop;

    const { runners, outputNode, cancel } = dag.buildRunners({
      context,
      input,
      chronicle,
      eventCb: this.eventCb,
      cache,
      autorun,
    });

    this.name = dag.config.name;
    this.tolerateFailures = dag.config.tolerateFailures ?? false;
    this.runners = runners;
    this.cancel = cancel;
    this.outputNode = outputNode;
    this.autorun = autorun ?? (() => true);
  }

  /** Run the entire DAG to completion */
  run(): Promise<OUTPUT> {
    return new Promise((resolve, reject) => {
      runInSpan(`DAG ${this.name}`, async () => {
        this.eventCb({
          data: { input: this.input },
          source: this.name,
          sourceNode: '',
          type: 'dag:start',
          meta: this.chronicleOptions?.defaults?.metadata,
        });

        for (let runner of this.runners) {
          // State events are just for the UI when the DAG is being actively monitored.
          runner.on('state', (e) => this.emit('state', e));

          if (!this.tolerateFailures) {
            runner.on('error', (e) => {
              this.eventCb({
                data: { error: e },
                source: this.name,
                sourceNode: '',
                type: 'dag:error',
                meta: this.chronicleOptions?.defaults?.metadata,
              });

              this.cancel.emit('cancel');
              reject(e);
            });
          }
        }

        this.outputNode.on('error', (e) => {
          this.cancel.emit('cancel');
          reject(e);
        });

        this.outputNode.on('finish', (e) => {
          this.eventCb({
            data: { output: e.output },
            source: this.name,
            sourceNode: '',
            type: 'dag:finish',
            meta: this.chronicleOptions?.defaults?.metadata,
          });

          resolve(e.output);
        });

        // Start running all root nodes
        if (this.autorun()) {
          for (let runner of this.runners) {
            if (!runner.config.parents?.length) {
              runner.run();
            }
          }
        }
      });
    });
  }
}

/** Create a run a DAG in one statement. This is equivalent to `new DagRunner(dag, context).run()` */
export async function runDag<CONTEXT extends object, INPUT, OUTPUT>(
  options: DagRunnerOptions<CONTEXT, INPUT, OUTPUT>
) {
  return await new DagRunner(options).run();
}
