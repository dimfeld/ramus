import { Span } from '@opentelemetry/api';

export type DagNodeState = 'waiting' | 'running' | 'cancelled' | 'error' | 'finished';

export interface DagNodeInput<CONTEXT extends object, INPUTS extends AnyInputs> {
  /** The context passed to the DAG by whatever started it. */
  context: CONTEXT;
  /** Inputs from the node's parents */
  input: INPUTS;
  /** The OpenTelemtry span for this execution. */
  span: Span;
  /** Return if this node has been cancelled due to failures elsewhere in the DAG. */
  isCancelled: () => boolean;
  /** Throw an NodeCancelledError if this node has been cancelled. This error
   * is handled bu the runner specially, to avoid marking it as an actual error.
   *
   * This is basically a shorthand for if(isCancelled()) { return; }
   * */
  exitIfCancelled: () => void;
}

export type AnyInputs = Record<string, unknown>;

export interface DagNode<CONTEXT extends object, INPUTS extends AnyInputs, OUTPUT> {
  parents?: Array<keyof INPUTS>;
  /** If true, run this node even if one of its parents has an error. */
  tolerateParentErrors?: boolean;
  run: (input: DagNodeInput<CONTEXT, INPUTS>) => OUTPUT | Promise<OUTPUT>;
}

export interface Dag<CONTEXT extends object> {
  name: string;
  description?: string;
  /** If true, keep running whatever we can when a node fails.
  When false or omitted, the entire DAG will end with an error if any node fails. */
  tolerateFailures?: boolean;
  nodes: DagConfiguration<CONTEXT>;
}

export type DagConfiguration<CONTEXT extends object> = Record<
  string,
  DagNode<CONTEXT, AnyInputs, unknown>
>;
