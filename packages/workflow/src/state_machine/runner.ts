import { EventEmitter } from 'events';
import * as opentelemetry from '@opentelemetry/api';
import {
  StateMachine,
  StateMachineNodeInput,
  StateMachineStatus,
  TransitionGuardInput,
} from './types.js';
import { Semaphore, SemaphoreReleaser, acquireSemaphores } from '../semaphore.js';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import { addSpanEvent, runInSpan, runInSpanWithParent, toSpanAttributeValue } from '../tracing.js';
import { Runnable, RunnableEvents } from '../runnable.js';
import { CancelledError } from '../errors.js';

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

  name: string;
  rootInput: ROOTINPUT;
  context: CONTEXT;
  config: StateMachine<CONTEXT, ROOTINPUT>;
  chronicleOptions?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback;
  semaphores?: Semaphore[];
  parentSpanContext?: opentelemetry.Context;
  stepIndex = 0;
  eventQueue: { type: string; data: unknown }[] = [];
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
        this.once('orchard:error', reject);
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
    this.stepIndex += 1;
    return runInSpan(
      `machine ${this.name} ${this.currentState}`,
      {
        attributes: {
          machine: this.name,
          step: this.currentState.state,
          step_index: this.stepIndex,
          input: toSpanAttributeValue(this.currentState.input),
          context: toSpanAttributeValue(this.context),
        },
      },
      async (span) => {
        let config = this.config.nodes[this.currentState.state];

        let chronicleOptions = {
          ...this.chronicleOptions,
          defaults: {
            ...this.chronicleOptions?.defaults,
            metadata: {
              ...this.chronicleOptions?.defaults?.metadata,
              step_index: this.stepIndex,
              step: this.currentState.state,
            },
          },
        };

        const notify = (type: string, data: unknown, spanEvent = true) => {
          if (spanEvent) {
            addSpanEvent(span, type, data);
          }

          this.eventCb({
            type,
            data,
            meta: chronicleOptions.defaults.metadata,
            source: this.name,
            sourceNode: this.currentState.state,
          });
        };

        if (this.machineStatus === 'initial') {
          notify('state_machine:start', {}, false);
        }

        let semRelease: SemaphoreReleaser | undefined;
        try {
          if (this.semaphores?.length && config.semaphoreKey) {
            this.setStatus('pendingSemaphore');
            semRelease = await acquireSemaphores(this.semaphores, config.semaphoreKey);
          }
          this.setStatus('running');

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

          // If some events were queued up while running, then try applying them now.
          let transitioned = false;
          if (this.eventQueue?.length) {
            let eventQueue = this.eventQueue;
            this.eventQueue = [];
            for (let { type, data } of eventQueue) {
              let t = this.runTransition(type, data);
              if (t) {
                transitioned = true;
                break;
              }
            }
          }

          if (!transitioned) {
            // None of the queued events triggered a transition, so just do the normal transition logic.
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
          notify('state_machine:error', { error: e }, false);
          this.emit('orchard:error', err);

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
      source: this.name,
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
  send(type: string, data: unknown) {
    if (this.machineStatus === 'running') {
      this.eventQueue.push({ type, data });
    } else {
      let transitioned = this.runTransition(type, data);
      if (transitioned) {
        this.updatePostTransition();
      }
    }
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
