import { EventEmitter } from 'events';
import { ChronicleClient, ChronicleClientOptions, createChronicleClient } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import type { AnyInputs, Dag, DagConfiguration, DagNode } from './types.js';
import { CompiledDag } from './compile.js';
import { DagNodeRunner } from './node_runner.js';
import { runInSpan, tracer } from '../tracing.js';

export interface DagRunnerOptions<CONTEXT extends object, OUTPUT = unknown> {
  dag: DagConfiguration<CONTEXT> | CompiledDag<CONTEXT, OUTPUT>;
  /** Options for a Chronicle LLM proxy client */
  chronicle?: ChronicleClientOptions;
  /** A function that can take events from the running DAG */
  event?: WorkflowEventCallback<unknown>;
}

export class DagRunner<CONTEXT extends object, OUTPUT> {
  name: string;
  context: CONTEXT;
  runners: DagNodeRunner<CONTEXT, AnyInputs, unknown>[];
  outputNode: DagNodeRunner<CONTEXT, AnyInputs, OUTPUT>;
  tolerateFailures: boolean;
  cancel: EventEmitter<{ cancel: [] }>;

  constructor(dag: Dag<CONTEXT> | CompiledDag<CONTEXT, OUTPUT>, context: CONTEXT) {
    if (!(dag instanceof CompiledDag)) {
      dag = new CompiledDag(dag);
    }

    this.context = context;
    const { runners, outputNode, cancel } = dag.buildRunners(context);

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
        if (!this.tolerateFailures) {
          for (let runner of this.runners) {
            runner.on('error', (e) => {
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
export async function runDag<CONTEXT extends object, OUTPUT>(
  dag: Dag<CONTEXT> | CompiledDag<CONTEXT, OUTPUT>,
  context: CONTEXT
) {
  return await new DagRunner(dag, context).run();
}
