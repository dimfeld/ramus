import { EventEmitter } from 'events';
import { ChronicleClient, ChronicleClientOptions, createChronicleClient } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import type { AnyInputs, DagConfiguration, DagNode } from './types.js';
import { CompiledDag } from './compile.js';
import { DagNodeRunner } from './node_runner.js';

export interface DagRunnerOptions<CONTEXT extends object, OUTPUT = unknown> {
  dag: DagConfiguration<CONTEXT> | CompiledDag<CONTEXT, OUTPUT>;
  /** Options for a Chronicle LLM proxy client */
  chronicle?: ChronicleClientOptions;
  /** A function that can take events from the running DAG */
  event?: WorkflowEventCallback<unknown>;
}

export class DagRunner<CONTEXT extends object, OUTPUT> {
  /** If true, halt on error. If false, continue running any portions of the DAG that were not affected by the error. */
  haltOnError = true;
  context: CONTEXT;
  runners: DagNodeRunner<CONTEXT, AnyInputs, unknown>[];
  outputNode: DagNodeRunner<CONTEXT, AnyInputs, OUTPUT>;
  cancel: EventEmitter<{ cancel: [] }>;

  constructor(dag: DagConfiguration<CONTEXT> | CompiledDag<CONTEXT, OUTPUT>, context: CONTEXT) {
    if (!(dag instanceof CompiledDag)) {
      dag = new CompiledDag(dag);
    }

    this.context = context;
    const { runners, outputNode, cancel } = dag.buildRunners(context);

    this.runners = runners;
    this.cancel = cancel;
    this.outputNode = outputNode;
  }

  /** Run the entire DAG to completion */
  run(): Promise<OUTPUT> {
    return new Promise((resolve, reject) => {
      for (let runner of this.runners) {
        runner.on('error', (e) => {
          this.cancel.emit('cancel');
          reject(e);
        });

        this.outputNode.on('error', (e) => {
          this.cancel.emit('cancel');
          reject(e);
        });
      }

      // TODO output Node needs a different runner that can emit a partial event if some of the
      // nodes had errors
      this.outputNode.on('finish', (e) => {
        resolve(e.output);
      });
      this.outputNode.run();

      // Start running all root nodes
      for (let runner of this.runners) {
        runner.run();
      }
    });
  }
}
