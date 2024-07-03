import * as opentelemetry from '@opentelemetry/api';
import { runStep, toSpanAttributeValue } from '@dimfeld/chronicle';
import { EventEmitter } from 'events';
import { CancelledError } from '../errors.js';
import { WorkflowEventCallback } from '../events.js';
import { Runnable, RunnableEvents } from '../runnable.js';
import { Semaphore, SemaphoreReleaser, acquireSemaphores } from '../semaphore.js';
import {
  StateMachine,
  StateMachineNodeInput,
  StateMachineSendEventOptions,
  StateMachineStatus,
  TransitionGuardInput,
} from './types.js';

export interface StateMachineRunnerOptions<CONTEXT extends object, ROOTINPUT> {
  config: StateMachine<CONTEXT, ROOTINPUT>;
  /** Override the name for this instance of the state machine. */
  name?: string;
  /** Start from a different initial state than the config indicates. */
  initial?: string;
  /** Use a different context than the default. */
  context?: CONTEXT;
  /** Semaphores which can be used to rate limit operations by the DAG. This accepts multiple Semaphores, which
   * can be used to provide a semaphore for global operations and another one for this particular DAG, for example. */
  semaphores?: Semaphore[];
  /** A function that can take events from the running state machine. This will use
   * the configured event callback from the event context, if omitted.*/
  eventCb?: WorkflowEventCallback;
  input: ROOTINPUT;
}

type StateMachineRunnerEvents<OUTPUT> = {
  'state_machine:state': [{ machineState: StateMachineStatus; state: string }];
} & RunnableEvents<OUTPUT>;

export class StateMachineRunner<CONTEXT extends object, ROOTINPUT, OUTPUT>
  extends EventEmitter<StateMachineRunnerEvents<OUTPUT>>
  implements Runnable<OUTPUT, StateMachineRunnerEvents<OUTPUT>>
{
  machineStatus: StateMachineStatus = 'initial';

  currentState: {
    state: string;
    previousState?: string;
    input?: any;
    // The event that caused the transition to this node, if any
    event?: { type: string; data: unknown };
    /** A cache of the output of the current node, for when we aren't transitioning right away. */
    output?: unknown;
  };

  name: string;
  rootInput: ROOTINPUT;
  context: CONTEXT;
  config: StateMachine<CONTEXT, ROOTINPUT>;
  semaphores?: Semaphore[];
  parentSpanContext?: opentelemetry.Context;
  stepIndex = 0;
  eventStep: string | undefined;
  machineStep: string | null = null;
  eventQueue: StateMachineSendEventOptions[] = [];
  _finished: Promise<OUTPUT> | undefined;

  constructor(options: StateMachineRunnerOptions<CONTEXT, ROOTINPUT>) {
    super();
    validateConfig(options.config);
    this.config = options.config;
    this.context = options.context ?? this.config.context();
    this.rootInput = options.input;
    this.semaphores = options.semaphores;
    this.name = options.name ? `${options.name}: ${options.config.name}` : options.config.name;

    const initial = options.initial ?? options.config.initial;
    if (!this.config.nodes[initial]) {
      throw new Error(`Initial state ${initial} does not exist`);
    }

    this.currentState = { state: options.config.initial, input: options.input };
    let parentSpan = opentelemetry.trace.getActiveSpan();
    if (parentSpan) {
      this.parentSpanContext = opentelemetry.trace.setSpan(
        opentelemetry.context.active(),
        parentSpan
      );
    }
  }

  get state() {
    return this.currentState.state;
  }

  get finished() {
    if (!this._finished) {
      this._finished = new Promise((resolve, reject) => {
        this.once('ramus:error', reject);
        this.once('cancelled', () => reject(new Error('Cancelled')));
        this.once('finish', resolve);
      });
    }

    return this._finished;
  }

  cancel() {
    this.setStatus('cancelled');
    this.emit('cancelled');
  }

  /** Run until the state machine has no more transitions to run. */
  async run() {
    if (!this.canStep()) {
      // Avoid creating an empty span if we can't do anything.
      return;
    }

    return await runStep(
      {
        name: this.name,
        type: 'state_machine',
        input: this.rootInput,
        tags: this.config.tags,
        // TODO also get info from the config
      },
      async () => {
        while (this.canStep()) {
          let lastState = this.currentState.state;
          try {
            await this.step();
          } catch (e) {
            // we handled the error already, but threw it up to here so that runStep would log it
          }

          if (this.machineStatus === 'error' && lastState === this.currentState.state) {
            // We hit an error but there is no error state, so halt for now. The state
            // machine can be manually retried.
            break;
          }
        }
      }
    );
  }

  /** Return true if the state machine can run a step right now. */
  canStep() {
    if (
      this.machineStatus === 'running' ||
      this.machineStatus === 'cancelled' ||
      this.machineStatus === 'waitingForEvent'
    ) {
      return false;
    }

    const node = this.config.nodes[this.currentState.state];
    if (node.run || typeof node.transition === 'string' || node.transition?.['']) {
      return true;
    }

    return false;
  }

  step() {
    this.stepIndex += 1;
    return runStep(
      {
        name: `${this.name} ${this.currentState}`,
        type: 'state_machine:node',
        input: this.currentState,
        tags: this.config.nodes[this.currentState.state].tags,
        // TODO also get info from the node
      },
      async (ctx, span) => {
        let config = this.config.nodes[this.currentState.state];
        let semRelease: SemaphoreReleaser | undefined;
        try {
          if (this.semaphores?.length && config.semaphoreKey) {
            this.setStatus('pendingSemaphore');
            semRelease = await acquireSemaphores(this.semaphores, config.semaphoreKey);
          }
          this.setStatus('running');

          let nodeInput: StateMachineNodeInput<CONTEXT, ROOTINPUT, any> = {
            context: this.context,
            isCancelled: () => this.machineStatus === 'cancelled',
            exitIfCancelled: () => {
              if (this.machineStatus === 'cancelled') {
                throw new CancelledError();
              }
            },
            previousState: this.currentState.previousState,
            input: this.currentState.input,
            event: this.currentState.event,
            rootInput: this.rootInput,
            span,
          };

          if (config.run) {
            this.currentState.output = await config.run(nodeInput);
            if (span.isRecording()) {
              span.setAttribute('output', toSpanAttributeValue(this.currentState.output as object));
            }
          }

          // If some events were queued up while running, then try applying them now.
          let transitioned = false;
          if (this.eventQueue?.length) {
            let i = 0;
            while (i < this.eventQueue.length) {
              let { type, data, queue } = this.eventQueue[i];

              let retainEvent: boolean | undefined;

              if (transitioned) {
                // We already transitioned, so keep `queue` events and drop others.
                retainEvent = queue;
              } else {
                let t = this.runTransition(type, data);
                if (t) {
                  transitioned = true;
                  // Drop the event since we handled it.
                  retainEvent = false;
                } else {
                  // We did not transition, so keep it if it was a `queue` event AND if we didn't have any event
                  // handler for it. This will drop the event if there was a handler but it chose not to act
                  // on it.
                  retainEvent = queue && !this.transitionsForEvent(type);
                }
              }

              if (retainEvent) {
                i++;
              } else {
                this.eventQueue.splice(i, 1);
              }
            }
          }

          if (!transitioned) {
            // None of the queued events triggered a transition, so try the "always" transition logic if present.
            transitioned = this.runTransition();
          }

          if (transitioned) {
            this.updatePostTransition();
          } else {
            this.setStatus('waitingForEvent');
          }

          return transitioned;
        } catch (e) {
          if (e instanceof CancelledError) {
            return false;
          }

          let errorState = config?.errorState ?? this.config.errorState;
          if (errorState) {
            this.transitionTo(errorState, e);
          }

          this.setStatus('error');

          // throw so that runStep will log the error
          throw e;
        } finally {
          semRelease?.();
        }
      }
    );
  }

  /** Update the machine's generic status. */
  private setStatus(newStatus: StateMachineStatus) {
    if (this.machineStatus === newStatus || this.machineStatus === 'cancelled') {
      return;
    }

    this.machineStatus = newStatus;

    this.emit('state', {
      machineState: this.machineStatus,
      state: this.currentState.state,
    });
  }

  private updatePostTransition() {
    if (this.machineStatus === 'cancelled') {
      return;
    }

    if (this.config.nodes[this.currentState.state].final) {
      this.setStatus('final');
    } else {
      this.setStatus('ready');
    }
  }

  private transitionsForEvent(eventType?: string) {
    const transitions = this.config.nodes[this.currentState.state].transition;
    if (typeof transitions === 'string') {
      // Unconditional transition, ignores events
      return eventType ? undefined : transitions;
    }

    return transitions?.[eventType ?? ''];
  }

  /** Figure out which transition to run for an event. */
  private resolveTransitions(eventType?: string, eventData?: unknown): string | undefined {
    const node = this.config.nodes[this.currentState.state];

    if (typeof node.transition === 'string') {
      // This node always transitions to this particular state so there's nothing to check.
      return node.transition;
    }

    const transition = node.transition?.[eventType ?? ''];

    if (!transition) {
      return;
    } else if (typeof transition === 'string') {
      return transition;
    } else {
      let transitionInput: TransitionGuardInput<CONTEXT, ROOTINPUT, any, any> = {
        context: this.context,
        input: this.currentState.input,
        output: this.currentState.output,
        rootInput: this.rootInput,
        event: eventType ? { type: eventType, data: eventData } : undefined,
      };

      let eventInput = eventType ? { type: eventType, data: eventData } : undefined;

      let tArray = Array.isArray(transition) ? transition : [transition];
      for (let t of tArray) {
        if (!t.condition) {
          // No condition so we always do it.
          return t.state;
        }

        let cond = t.condition(transitionInput, eventInput);
        if (cond === true) {
          return t.state;
        } else if (typeof cond === 'object') {
          // If you return an object we assume that you want to transition unless explicitly said otherwise.
          if (cond.transition == null || cond.transition === true) {
            return t.state;
          }
        }
      }
    }
  }

  private transitionTo(nextState: string, input: unknown, eventType?: string, eventData?: unknown) {
    this.currentState = {
      previousState: this.currentState.state,
      event: eventType ? { type: eventType, data: eventData } : undefined,
      state: nextState,
      input,
    };
  }

  /** Run a transition for the given event, if one exists and the condition passes. */
  private runTransition(eventType?: string, eventData?: unknown): boolean {
    let nextState = this.resolveTransitions(eventType, eventData);
    if (!nextState) {
      return false;
    }

    this.transitionTo(nextState, this.currentState.output, eventType, eventData);
    return true;
  }

  /** Send an event to the state machine. */
  send(options: StateMachineSendEventOptions) {
    if (
      this.machineStatus === 'running' ||
      (options.queue && !this.transitionsForEvent(options.type))
    ) {
      this.eventQueue.push(options);
    } else {
      let transitioned = this.runTransition(options.type, options.data);
      if (transitioned) {
        this.updatePostTransition();
      }
    }
  }

  /** Return a list of events that the current state can handle. */
  availableEvents(): string[] {
    return Object.keys(this.config.nodes[this.currentState.state].transition ?? {}).filter(
      // filter out empty string
      (name) => name
    );
  }
}

function validateConfig(config: StateMachine<any, any>) {
  if (!config.initial) {
    throw new Error(`No initial state`);
  }

  if (!config.nodes[config.initial]) {
    throw new Error(`Initial state ${config.initial} does not exist`);
  }

  if (config.errorState && !config.nodes[config.errorState]) {
    throw new Error(`Error state ${config.errorState} does not exist`);
  }

  for (let [state, node] of Object.entries(config.nodes)) {
    if (node.errorState && !config.nodes[node.errorState]) {
      throw new Error(`Error state ${config.errorState} does not exist`);
    }

    if (typeof node.transition === 'string') {
      if (!config.nodes[node.transition]) {
        throw new Error(`State ${state} Transition target ${node.transition} does not exist`);
      }
    } else {
      for (let transition of Object.values(node.transition ?? {})) {
        if (typeof transition === 'string') {
          if (!config.nodes[transition]) {
            throw new Error(`State ${state} Transition target ${transition} does not exist`);
          }
        } else if (Array.isArray(transition)) {
          for (let t of transition) {
            if (!config.nodes[t.state]) {
              throw new Error(`State ${state} Transition target ${t} does not exist`);
            }
          }
        }
      }
    }
  }
}
