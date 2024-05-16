import { Span } from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { DagRunnerOptions } from './runner.js';
import { Intervention } from '../interventions.js';
import { NodeInput } from '../types.js';
import { Schema } from 'jsonschema';

export type DagNodeState =
  | 'waiting'
  | 'ready'
  | 'intervention'
  | 'pendingSemaphore'
  | 'running'
  | 'cancelled'
  | 'error'
  | 'finished';

/** The structure passed to a DAG node when it executes. */
export type DagNodeInput<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS extends AnyInputs,
  INTERVENTIONRESPONSE = undefined,
> = NodeInput<CONTEXT, ROOTINPUT, INPUTS, INTERVENTIONRESPONSE>;

export type AnyInputs = Record<string, unknown>;

export interface DagNode<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS extends AnyInputs,
  OUTPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> {
  parents?: Array<keyof INPUTS>;
  /** If set, participate in global rate limiting of nodes with the same `semaphoreKey`. */
  semaphoreKey?: string;
  /** If true, run this node even if one of its parents has an error. */
  tolerateParentErrors?: boolean;

  /** Check if this node requires user intervention before it can run. The `input` argument is the input
   * that the node will receive, and `response` is the user's latest response, if any. This function is intentionally
   * simple. For more complex needs you should embed a state machine instead. */
  requiresIntervention?: (input: {
    context: CONTEXT;
    input: INPUTS;
    rootInput: ROOTINPUT;
    response?: INTERVENTIONRESPONSE;
  }) => Omit<Intervention<INTERVENTIONDATA>, 'id'> | undefined;

  run: (
    input: DagNodeInput<CONTEXT, ROOTINPUT, INPUTS, INTERVENTIONRESPONSE>
  ) => OUTPUT | Promise<OUTPUT>;
}

export interface Dag<
  CONTEXT extends object,
  INPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> {
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
  nodes: DagConfiguration<CONTEXT, INPUT, INTERVENTIONDATA, INTERVENTIONRESPONSE>;
}

export type DagConfiguration<
  CONTEXT extends object,
  ROOTINPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
> = Record<
  string,
  DagNode<CONTEXT, ROOTINPUT, AnyInputs, unknown, INTERVENTIONDATA, INTERVENTIONRESPONSE>
>;

export type DagOutput<NODE> = NODE extends DagNode<any, any, any, infer OUTPUT> ? OUTPUT : never;

export type DagInputs<T extends Record<string, DagNode<any, any, any, any>>> = {
  [k in keyof T]: DagOutput<T[k]>;
};
