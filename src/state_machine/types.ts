import { Schema } from 'jsonschema';
import { Intervention } from '../interventions.js';
import { NodeInput } from '../types.js';

/** A generic idea of what the state machine is doing. */
export type StateMachineGenericState =
  | 'initial'
  | 'intervention'
  | 'running'
  | 'end'
  | 'error'
  | 'cancelled';

export interface StateMachine<
  CONTEXT extends object,
  ROOTINPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> {
  name: string;
  /** The description of this DAG. This will go into the tool description if this DAG can be used as a tool. */
  description?: string;
  /** The schema for the input data, if this DAG can be used as a tool. */
  inputSchema?: Schema;

  /** Transition to this state if a node throws an exception. */
  errorState?: string;

  /** Where the state machine should start */
  initial: string;
  nodes: Record<
    string,
    StateMachineNode<CONTEXT, ROOTINPUT, any, any, INTERVENTIONDATA, INTERVENTIONRESPONSE>
  >;
}

export interface StateMachineNode<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS,
  OUTPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> {
  /** Transition to this state if a node throws an exception. Overrides the global errorState value. */
  errorState?: string;
  /** Return an intervention to resolve before running this node. */
  intervention?: (
    input: NodeInput<CONTEXT, ROOTINPUT, INPUTS, never>
  ) => Intervention<INTERVENTIONDATA> | undefined;
  /** Run the code for this node, if any. */
  run?: (input: NodeInput<CONTEXT, ROOTINPUT, INPUTS, INTERVENTIONRESPONSE>) => Promise<OUTPUT>;
  /** The next state after the node has finished running. */
  transition:
    | string
    | StateMachineTransition<CONTEXT, ROOTINPUT, INPUTS, OUTPUT, INTERVENTIONRESPONSE>[];
  semaphoreKey?: string;
  cacheable?: boolean;
}

export type StateMachineTransitionFunc<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS,
  OUTPUT,
  INTERVENTIONRESPONSE,
> = (
  input: NodeInput<CONTEXT, ROOTINPUT, INPUTS, INTERVENTIONRESPONSE>,
  output: OUTPUT
) => boolean | { transition: boolean; after?: number };

export type StateMachineTransition<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS,
  OUTPUT,
  INTERVENTIONRESPONSE,
> =
  | string
  | {
      state: string;
      condition?: StateMachineTransitionFunc<
        CONTEXT,
        ROOTINPUT,
        INPUTS,
        OUTPUT,
        INTERVENTIONRESPONSE
      >;
    };
