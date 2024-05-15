import { EventEmitter } from 'events';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import type { AnyInputs, Dag, DagNodeState } from './types.js';
import { CompiledDag } from './compile.js';
import { DagNodeRunner } from './node_runner.js';
import { runInSpan } from '../tracing.js';
import { NodeResultCache } from '../cache.js';
import { Semaphore } from '../semaphore.js';
import { Intervention } from '../interventions.js';

export interface DagRunnerOptions<
  CONTEXT extends object,
  ROOTINPUT,
  OUTPUT = unknown,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> {
  dag:
    | Dag<CONTEXT, ROOTINPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>
    | CompiledDag<CONTEXT, ROOTINPUT, OUTPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>;
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

export class DagRunner<
  CONTEXT extends object,
  ROOTINPUT,
  OUTPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> extends EventEmitter<{
  state: [{ sourceNode: string; source: string; state: DagNodeState }];
  intervention: [Intervention<INTERVENTIONDATA>];
}> {
  name: string;
  context?: CONTEXT;
  runners: Map<
    string,
    DagNodeRunner<CONTEXT, ROOTINPUT, AnyInputs, any, INTERVENTIONDATA, INTERVENTIONRESPONSE>
  >;
  outputNode: DagNodeRunner<
    CONTEXT,
    ROOTINPUT,
    AnyInputs,
    OUTPUT,
    INTERVENTIONDATA,
    INTERVENTIONRESPONSE
  >;
  tolerateFailures: boolean;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  autorun: () => boolean;
  input: ROOTINPUT;
  output: OUTPUT | undefined;

  requestedInterventions: Map<string, { data: Intervention<INTERVENTIONDATA>; node: string }> =
    new Map();

  cancel: EventEmitter<{ cancel: [] }>;

  constructor({
    dag,
    context,
    input,
    chronicle,
    eventCb,
    cache,
    autorun,
    semaphores,
  }: DagRunnerOptions<CONTEXT, ROOTINPUT, OUTPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>) {
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
      semaphores,
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

        for (let runner of this.runners.values()) {
          // State events are just for the UI when the DAG is being actively monitored.
          runner.on('state', (e) => this.emit('state', e));
          runner.on('intervention', (e) => {
            this.requestedInterventions.set(e.id, { data: e, node: runner.name });
            this.emit('intervention', e);
          });

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

          this.output = e.output;
          resolve(e.output);
        });

        // Start running all root nodes
        if (this.autorun()) {
          for (let runner of this.runners.values()) {
            if (!runner.config.parents?.length) {
              runner.run();
            }
          }
        }
      });
    });
  }

  respondToIntervention(id: string, response: INTERVENTIONRESPONSE) {
    const intervention = this.requestedInterventions.get(id);
    if (!intervention) {
      throw new Error('Intervention id not found');
    }

    this.requestedInterventions.delete(id);
    const runner = this.runners.get(intervention.node);
    if (!runner) {
      throw new Error(`Node runner ${intervention.node} not found`);
    }

    return runner.run(false, response);
  }
}

/** Create a run a DAG in one statement. This is equivalent to `new DagRunner(dag, context).run()` */
export async function runDag<CONTEXT extends object, INPUT, OUTPUT>(
  options: DagRunnerOptions<CONTEXT, INPUT, OUTPUT>
) {
  return await new DagRunner(options).run();
}
