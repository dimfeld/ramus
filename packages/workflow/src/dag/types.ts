import { NodeInput } from '../types.js';
import { Schema } from 'jsonschema';

export type DagNodeState =
  | 'waiting'
  | 'ready'
  | 'pendingSemaphore'
  | 'running'
  | 'cancelled'
  | 'error'
  | 'finished';

/** The structure passed to a DAG node when it executes. */
export type DagNodeInput<CONTEXT extends object, ROOTINPUT, INPUTS extends AnyInputs> = NodeInput<
  CONTEXT,
  ROOTINPUT,
  INPUTS
>;

export type AnyInputs = Record<string, unknown>;

export interface DagNode<CONTEXT extends object, ROOTINPUT, INPUTS extends AnyInputs, OUTPUT> {
  parents?: Array<keyof INPUTS>;
  /** If set, participate in global rate limiting of nodes with the same `semaphoreKey`. */
  semaphoreKey?: string;
  /** If true, run this node even if one of its parents has an error. */
  tolerateParentErrors?: boolean;

  tags?: string[];

  run: (input: DagNodeInput<CONTEXT, ROOTINPUT, INPUTS>) => OUTPUT | Promise<OUTPUT>;
}

export interface Dag<CONTEXT extends object, INPUT> {
  name: string;
  /** Build the DAG's context, if it was not supplied externally. */
  context: () => CONTEXT;
  /** The description of this DAG. This will go into the tool description if this DAG can be used as a tool. */
  description?: string;
  /** The schema for the input data, if this DAG can be used as a tool. */
  inputSchema?: Schema;
  /** If true, keep running whatever we can when a node fails.
  When false or omitted, the entire DAG will end with an error if any node fails. */
  tolerateFailures?: boolean;
  tags?: string[];
  nodes: DagConfiguration<CONTEXT, INPUT>;
}

export type DagConfiguration<CONTEXT extends object, ROOTINPUT> = Record<
  string,
  DagNode<CONTEXT, ROOTINPUT, AnyInputs, unknown>
>;

export type DagOutput<NODE> = NODE extends DagNode<any, any, any, infer OUTPUT> ? OUTPUT : never;

export type DagInputs<T extends Record<string, DagNode<any, any, any, any>>> = {
  [k in keyof T]: DagOutput<T[k]>;
};
