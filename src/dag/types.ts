import { Span } from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { DagRunnerOptions } from './runner.js';

export type DagNodeState = 'waiting' | 'running' | 'cancelled' | 'error' | 'finished';

/** The structure passed to a DAG node when it executes. */
export interface DagNodeInput<CONTEXT extends object, INPUTS extends AnyInputs> {
  /** The context passed to the DAG by whatever started it. */
  context: CONTEXT;
  /** Inputs from the node's parents */
  input: INPUTS;
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
   */
  event: (type: string, data: unknown) => void;

  /** Run another DAG as part of this execution. */
  runDag<CONTEXT extends object, OUTPUT>(
    options: Omit<DagRunnerOptions<CONTEXT, OUTPUT>, 'chronicle' | 'eventCb'>
  ): Promise<OUTPUT>;
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
