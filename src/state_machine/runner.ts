import { EventEmitter } from 'events';
import { StateMachine } from './types.js';
import { Intervention } from '../interventions.js';
import { NodeResultCache } from '../cache.js';
import { Semaphore } from '../semaphore.js';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';

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

export class StateMachineRunner<
  CONTEXT extends object,
  ROOTINPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> extends EventEmitter<{
  'state_machine:state': [{ state: string }];
  intervention: [Intervention<INTERVENTIONDATA>];
}> {
  currentState: string;
  context: CONTEXT;
  config: StateMachine<CONTEXT, ROOTINPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  cache?: NodeResultCache;
  semaphores?: Semaphore[];
  autorun: () => boolean;

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

    this.currentState = options.config.initial;
  }

  respondToIntervention(id: string, data: INTERVENTIONRESPONSE) {
    if (!this.interventionIds.has(id)) {
      return;
    }

    // TODO
    // If this is a general runner then we want to respondToIntervention.
    // If it's an state machine node then we just run it
    this.interventionIds.delete(id);
    this.run(data);
  }

  run(interventionResponse?: INTERVENTIONRESPONSE) {
    // run the current node
  }
}

function validateConfig(config: StateMachine<any, any, any, any>) {
  // TODO check that transition states all exist, etc.
}
