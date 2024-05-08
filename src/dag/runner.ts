import { EventEmitter } from 'events';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import type { AnyInputs, Dag } from './types.js';
import { CompiledDag } from './compile.js';
import { DagNodeRunner } from './node_runner.js';
import { runInSpan } from '../tracing.js';

export interface DagRunnerOptions<CONTEXT extends object, ROOTINPUT, OUTPUT = unknown> {
  dag: Dag<CONTEXT, ROOTINPUT> | CompiledDag<CONTEXT, ROOTINPUT, OUTPUT>;
  input: ROOTINPUT;
  context?: CONTEXT;
  /** Options for a Chronicle LLM proxy client */
  chronicle?: ChronicleClientOptions;
  /** A function that can take events from the running DAG */
  eventCb?: WorkflowEventCallback;
}

function noop() {}

export class DagRunner<CONTEXT extends object, ROOTINPUT, OUTPUT> {
  name: string;
  context?: CONTEXT;
  runners: DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, unknown>[];
  outputNode: DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, OUTPUT>;
  tolerateFailures: boolean;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  input: ROOTINPUT;

  cancel: EventEmitter<{ cancel: [] }>;

  constructor({
    dag,
    context,
    input,
    chronicle,
    eventCb,
  }: DagRunnerOptions<CONTEXT, ROOTINPUT, OUTPUT>) {
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
    });

    this.name = dag.config.name;
    this.tolerateFailures = dag.config.tolerateFailures ?? false;
    this.runners = runners;
    this.cancel = cancel;
    this.outputNode = outputNode;
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

        if (!this.tolerateFailures) {
          for (let runner of this.runners) {
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
        for (let runner of this.runners) {
          if (!runner.config.parents?.length) {
            runner.run();
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
