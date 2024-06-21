import * as opentelemetry from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { EventEmitter } from 'events';
import { uuidv7 } from 'uuidv7';
import { CancelledError } from '../errors.js';
import { WorkflowEventCallback } from '../events.js';
import { Runnable, RunnableEvents } from '../runnable.js';
import { Semaphore, SemaphoreReleaser, acquireSemaphores } from '../semaphore.js';
import {
  addSpanEvent,
  getEventContext,
  runInSpanWithParent,
  runStep,
  toSpanAttributeValue,
} from '../tracing.js';
import {
  StateMachine,
  StateMachineNodeInput,
  StateMachineSendEventOptions,
  StateMachineStatus,
  TransitionGuardInput,
} from './types.js';
import { NotifyArgs } from '../types.js';

export interface StateMachineRunnerOptions<CONTEXT extends object, ROOTINPUT> {
  config: StateMachine<CONTEXT, ROOTINPUT>;
  /** Override the name for this instance of the state machine. */
  name?: string;
  // A UUID for the instance of the state machine. This will be autogenrated as a UUIDv7 if not provided.
  id?: string;
  /** Start from a different initial state than the config indicates. */
  initial?: string;
  /** Use a different context than the default. */
  context?: CONTEXT;
  /** Semaphores which can be used to rate limit operations by the DAG. This accepts multiple Semaphores, which
   * can be used to provide a semaphore for global operations and another one for this particular DAG, for example. */
  semaphores?: Semaphore[];
  /** Options for a Chronicle LLM proxy client */
  chronicle?: ChronicleClientOptions;
  /** A function that can take events from the running DAG */
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

  id: string;
  name: string;
  rootInput: ROOTINPUT;
  context: CONTEXT;
  config: StateMachine<CONTEXT, ROOTINPUT>;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
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
    this.chronicleOptions = options.chronicle;
    this.semaphores = options.semaphores;
    this.eventCb = options.eventCb ?? (() => {});
    this.name = options.name ? `${options.name}: ${options.config.name}` : options.config.name;
    this.id = options.id || uuidv7();

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

    return await runInSpanWithParent(
      `machine ${this.name}`,
      {},
      this.parentSpanContext,
      async () => {
        while (this.canStep()) {
          let transitioned = await this.step();
          if (this.machineStatus === 'error' && !transitioned) {
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
    if (this.machineStep === null) {
      this.machineStep = uuidv7();
    }

    if (this.machineStatus === 'initial') {
      this.eventCb({
        type: 'state_machine:start',
        data: { parent_step: getEventContext().parentStep, input: this.rootInput },
        meta: this.chronicleOptions?.defaults?.metadata,
        source: this.name,
        sourceId: this.id,
        sourceNode: '',
        step: this.machineStep,
      });
    }

    this.stepIndex += 1;
    return runStep(
      `machine ${this.name} ${this.currentState}`,
      this.machineStep,
      {
        attributes: {
          machine: this.name,
          step: this.currentState.state,
          step_index: this.stepIndex,
          input: toSpanAttributeValue(this.currentState.input),
          context: toSpanAttributeValue(this.context),
        },
      },
      undefined,
      async (span) => {
        this.eventStep = getEventContext().currentStep!;
        let config = this.config.nodes[this.currentState.state];

        let chronicleOptions = {
          ...this.chronicleOptions,
          defaults: {
            ...this.chronicleOptions?.defaults,
            metadata: {
              ...this.chronicleOptions?.defaults?.metadata,
              step_index: this.stepIndex,
              step: this.eventStep,
            },
          },
        };

        const notify = (e: NotifyArgs, spanEvent = true) => {
          if (spanEvent) {
            addSpanEvent(span, e);
          }

          this.eventCb({
            ...e,
            data: e.data || null,
            meta: chronicleOptions.defaults.metadata,
            source: this.name,
            sourceId: this.id,
            sourceNode: this.currentState.state,
            step: this.eventStep,
          });
        };

        let semRelease: SemaphoreReleaser | undefined;
        try {
          if (this.semaphores?.length && config.semaphoreKey) {
            this.setStatus('pendingSemaphore');
            semRelease = await acquireSemaphores(this.semaphores, config.semaphoreKey);
          }
          this.setStatus('running');
          this.eventCb({
            type: 'state_machine:node_start',
            sourceId: this.id,
            source: this.name,
            step: this.eventStep,
            sourceNode: this.currentState.state,
            data: {
              input: this.currentState.input,
              event: this.currentState.event,
              parent_step: this.machineStep,
            },
          });

          let nodeInput: StateMachineNodeInput<CONTEXT, ROOTINPUT, any> = {
            context: this.context,
            notify,
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
            chronicleOptions,
          };

          if (config.run) {
            this.currentState.output = await config.run(nodeInput);
            span.setAttribute('output', toSpanAttributeValue(this.currentState.output as object));
          }

          this.eventCb({
            type: 'state_machine:node_finish',
            sourceId: this.id,
            source: this.name,
            step: this.eventStep,
            sourceNode: this.currentState.state,
            data: {
              output: this.currentState.output,
            },
          });

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

          let err = e as Error;

          let errorState = config?.errorState ?? this.config.errorState;
          if (errorState) {
            this.transitionTo(errorState, e);
          }

          this.setStatus('error');
          notify({ type: 'state_machine:error', data: { error: e } }, false);
          this.emit('ramus:error', err);

          span.recordException(err);
          span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR });
          span.setAttribute('error', err.message ?? 'true');

          return Boolean(errorState);
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

    this.eventCb({
      type: 'state_machine:status',
      sourceId: this.id,
      source: this.name,
      step: this.eventStep,
      sourceNode: this.currentState.state,
      data: {
        status: newStatus,
      },
    });

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
    const nextNode = this.config.nodes[nextState];
    this.eventCb({
      type: 'state_machine:transition',
      data: {
        from: this.currentState.state,
        to: nextState,
        input: this.currentState.input,
        output: this.currentState.output,
        event: eventType,
        eventData: eventData,
        final: nextNode.final,
      },
      sourceId: this.id,
      source: this.name,
      step: this.eventStep,
      sourceNode: this.currentState.state,
    });

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
