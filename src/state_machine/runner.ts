import { EventEmitter } from 'events';
import * as opentelemetry from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { StateMachine, StateMachineStatus, TransitionGuardInput } from './types.js';
import { Semaphore, SemaphoreReleaser, acquireSemaphores } from '../semaphore.js';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';
import {
  addSpanEvent,
  runInSpan,
  runInSpanWithParent,
  toSpanAttributeValue,
  tracer,
} from '../tracing.js';
import { Runnable, RunnableEvents } from '../runnable.js';
import { NodeInput } from '../types.js';
import { CancelledError } from '../errors.js';

export interface StateMachineRunnerOptions<CONTEXT extends object, ROOTINPUT> {
  config: StateMachine<CONTEXT, ROOTINPUT>;
  /** Override the name for this instance of the state machine. */
  name?: string;
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
    input?: any;
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
  autorun: () => boolean;
  eventQueue: { type: string; data: unknown }[] = [];
  _finished: Promise<OUTPUT> | undefined;

  constructor(options: StateMachineRunnerOptions<CONTEXT, ROOTINPUT>) {
    super();
    validateConfig(options.config);
    this.config = options.config;
    this.context = options.context;
    this.rootInput = options.input;
    this.chronicleOptions = options.chronicle;
    this.semaphores = options.semaphores;
    this.eventCb = options.eventCb ?? (() => {});
    this.autorun = options.autorun ?? (() => true);
    this.name = options.name || options.config.name;

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
        this.once('error', reject);
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
          await this.step();
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
    if (node.run || node.transition?.['']) {
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

        const sendEvent = (type: string, data: unknown, spanEvent = true) => {
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
          sendEvent('state_machine:start', {}, false);
        }

        let semRelease: SemaphoreReleaser | undefined;
        try {
          if (this.semaphores?.length && config.semaphoreKey) {
            this.setStatus('pendingSemaphore');
            semRelease = await acquireSemaphores(this.semaphores, config.semaphoreKey);
          }
          this.setStatus('running');

          let nodeInput: NodeInput<CONTEXT, ROOTINPUT, any> = {
            context: this.context,
            event: sendEvent,
            isCancelled: () => this.machineStatus === 'cancelled',
            exitIfCancelled: () => {
              if (this.machineStatus === 'cancelled') {
                throw new CancelledError();
              }
            },
            input: this.currentState.input,
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
          sendEvent('state_machine:error', { error: e });
          this.emit('error', err);

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
          if (cond.transition === true) {
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
  // TODO check that transition states all exist, etc.
}
