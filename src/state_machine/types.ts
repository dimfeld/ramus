import { Schema } from 'jsonschema';
import { NodeInput } from '../types.js';
import { Runnable } from '../runnable.js';

/** A generic idea of what the state machine is doing. */
export type StateMachineStatus =
  | 'initial'
  | 'ready'
  | 'pendingSemaphore'
  | 'running'
  | 'waitingForEvent'
  | 'final'
  | 'error'
  | 'cancelled';

export interface StateMachine<CONTEXT extends object, ROOTINPUT> {
  name: string;
  /** The description of this DAG. This will go into the tool description if this DAG can be used as a tool. */
  description?: string;
  /** The schema for the input data, if this DAG can be used as a tool. */
  inputSchema?: Schema;

  /** Transition to this state if a node throws an exception. */
  errorState?: string;

  /** Where the state machine should start */
  initial: string;
  nodes: Record<string, StateMachineNode<CONTEXT, ROOTINPUT, any, any>>;
}

export interface StateMachineNode<CONTEXT extends object, ROOTINPUT, INPUTS, OUTPUT> {
  /** Run the code for this node, if any. */
  run?: (input: NodeInput<CONTEXT, ROOTINPUT, INPUTS>) => Promise<OUTPUT>;

  /** Mark this state as a final state.  Final states can still have transitions, such as if this
   * state machine interacts with a user and may or may not receive a response. This is only used to
   * give the state machine's user some idea of what's going on and serves no functional purpose.. */
  final?: boolean;

  /** Transition to this state if a node throws an exception. Overrides the global errorState value. */
  errorState?: string;

  /** Mapping of events to transitions. Use the empty string to indicate a transition that always fires. */
  transition?: Record<
    string,
    | StateMachineTransition<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>
    | Array<StateMachineTransition<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>>
  >;

  semaphoreKey?: string;

  cacheable?: boolean;
}

export interface TransitionGuardInput<CONTEXT, ROOTINPUT, INPUTS, OUTPUT> {
  context: CONTEXT;
  output: OUTPUT;
  input: INPUTS;
  rootInput: ROOTINPUT;
}

export type StateMachineTransitionGuard<CONTEXT extends object, ROOTINPUT, INPUTS, OUTPUT> = (
  input: TransitionGuardInput<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>,
  event?: { type: string; data: unknown }
) =>
  | boolean
  | {
      /** If true, run this transition */
      transition: boolean;
      // TODO Not implemented yet
      // /** If set, wait this long to trigger the transition. Other events can arrive and trigger a different
      //  * transition in the meantime. */
      // afterMs?: number;
    };

/** A state machine transition. */
export type StateMachineTransition<CONTEXT extends object, ROOTINPUT, INPUTS, OUTPUT> = {
  /** The destination state */
  state: string;
  /** Trigger this transition if the condition is true */
  condition?: StateMachineTransitionGuard<CONTEXT, ROOTINPUT, INPUTS, OUTPUT>;
};
