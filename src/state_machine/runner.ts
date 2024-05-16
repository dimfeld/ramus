import { EventEmitter } from 'events';
import { StateMachine, StateMachineGenericState } from './types.js';
import { Intervention } from '../interventions.js';
import { NodeResultCache } from '../cache.js';
import { Semaphore } from '../semaphore.js';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import { runInSpan } from '../tracing.js';
import { Runnable, RunnableEvents } from '../runnable.js';

export interface StateMachineRunnerOptions<
  CONTEXT extends object,
  ROOTINPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> {
  config: StateMachine<CONTEXT, ROOTINPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>;
  cache?: NodeResultCache;
  context: CONTEXT;
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

type StateMachineRunnerEvents<OUTPUT, INTERVENTIONDATA> = {
  'state_machine:state': [{ machineState: StateMachineGenericState; state: string }];
} & RunnableEvents<OUTPUT, INTERVENTIONDATA>;

export class StateMachineRunner<
    CONTEXT extends object,
    ROOTINPUT,
    OUTPUT,
    INTERVENTIONDATA = undefined,
    INTERVENTIONRESPONSE = unknown,
  >
  extends EventEmitter<StateMachineRunnerEvents<OUTPUT, INTERVENTIONDATA>>
  implements
    Runnable<
      OUTPUT,
      INTERVENTIONDATA,
      INTERVENTIONRESPONSE,
      StateMachineRunnerEvents<OUTPUT, INTERVENTIONDATA>
    >
{
  genericState: StateMachineGenericState;
  currentState: string;
  context: CONTEXT;
  config: StateMachine<CONTEXT, ROOTINPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  cache?: NodeResultCache;
  semaphores?: Semaphore[];
  autorun: () => boolean;
  _finished: Promise<OUTPUT> | undefined;

  interventionIds: Set<string> = new Set();

  constructor(
    options: StateMachineRunnerOptions<CONTEXT, ROOTINPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>
  ) {
    super();
    validateConfig(options.config);
    this.config = options.config;
    this.context = options.context;
    this.cache = options.cache;
    this.semaphores = options.semaphores;
    this.eventCb = options.eventCb ?? (() => {});
    this.autorun = options.autorun ?? (() => true);

    this.genericState = 'initial';
    this.currentState = options.config.initial;
  }

  respondToIntervention(id: string, data: INTERVENTIONRESPONSE) {
    if (!this.interventionIds.has(id)) {
      return;
    }

    // TODO
    // If this is a general runner then we want to respondToIntervention.
    // If it's an state machine node then we just run it
    // These differences can be resolved by using a runner for each state node as well
    this.interventionIds.delete(id);
    this.run(data);
  }

  get finished() {
    if (!this._finished) {
      this._finished = new Promise((resolve, reject) => {
        this.once('error', reject);
        this.once('cancelled', () => reject(new Error('Cancelled')));
        this.once('finish', resolve);
      });
    }

    return this._finished;
  }

  cancel() {
    this.genericState = 'cancelled';
  }

  run(interventionResponse?: INTERVENTIONRESPONSE) {
    return runInSpan(`StateMachine ${this.config.name}`, async (span) => {
      this.eventCb({
        data: { state: this.currentState },
        source: this.config.name,
        sourceNode: '',
        type: 'state_machine:start',
        meta: this.chronicleOptions?.defaults?.metadata,
      });

      let config = this.config.nodes[this.currentState];

      if (config.intervention) {
        // TODO call the intervention function and emit it if one happens
      }

      // TODO run the node, being sensitive to interventions that may be triggered from the node runner.
      // TODO make a separate node runner for state machines
      //
    });
  }
}

function validateConfig(config: StateMachine<any, any, any, any>) {
  // TODO check that transition states all exist, etc.
}
