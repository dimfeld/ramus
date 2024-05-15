import { Span } from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { DagRunnerOptions } from './runner.js';
import { Intervention } from '../interventions.js';

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
export interface DagNodeInput<
  CONTEXT extends object,
  ROOTINPUT,
  INPUTS extends AnyInputs,
  INTERVENTIONRESPONSE = undefined,
> {
  /** The context passed to the DAG by whatever started it. */
  context: CONTEXT;
  /** Inputs from the node's parents */
  input: INPUTS;
  /** Input from the code that spawned this DAG */
  rootInput: ROOTINPUT;
  /** The response given for this node's intervention, if applicable. */
  interventionResponse?: INTERVENTIONRESPONSE;
  /** The OpenTelemetry span for this execution. */
  span: Span;
  /** Return if this node has been cancelled due to failures elsewhere in the DAG. */
  isCancelled: () => boolean;
  /** Throw an NodeCancelledError if this node has been cancelled. This error
   * is handled bu the runner specially, to avoid marking it as an actual error.
   *
   * This is equivalent to `if(isCancelled()) { return; }`
   * */
  exitIfCancelled: () => void;
  /** If a ChronicleClientOptions was supplied to the DAG, this is that object, cloned
   * and modified to set the step name to this DAG node's name. */
  chronicleOptions?: ChronicleClientOptions;

  /** Send an event to the system that created the DAG. This can be used for status updates while
   * the DAG is running.
   *
   * The event will be recorded on the active Span unless `spanEvent` is false.
   */
  event: (type: string, data: unknown, spanEvent?: boolean) => void;

  /** Run another DAG as part of this execution. */
  runDag<CONTEXT extends object, NEWINPUT, OUTPUT>(
    options: Omit<DagRunnerOptions<CONTEXT, NEWINPUT, OUTPUT>, 'chronicle' | 'eventCb' | 'autorun'>
  ): Promise<OUTPUT>;
}

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
  description?: string;
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
