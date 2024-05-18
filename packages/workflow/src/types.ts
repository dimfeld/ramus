import { Span } from '@opentelemetry/api';
import { ChronicleClientOptions } from 'chronicle-proxy';

export interface NodeInput<CONTEXT extends object, ROOTINPUT, INPUTS> {
  /** The context passed to the DAG by whatever started it. */
  context: CONTEXT;
  /** Inputs from the node's parents */
  input: INPUTS;
  /** Input from the code that spawned this DAG */
  rootInput: ROOTINPUT;
  /** The OpenTelemetry span for this execution. */
  span: Span;
  /** If a ChronicleClientOptions was supplied to the DAG, this is that object, cloned
   * and modified to set the step name to this DAG node's name. */
  chronicleOptions?: ChronicleClientOptions;

  /** Send an event to the system that created the DAG. This can be used for status updates while
   * the DAG is running.
   *
   * The event will be recorded on the active Span unless `spanEvent` is false.
   */
  event: (type: string, data: unknown, spanEvent?: boolean) => void;

  /** Return if this node has been cancelled due to failures elsewhere in the DAG. */
  isCancelled: () => boolean;
  /** Throw an NodeCancelledError if this node has been cancelled. This error
   * is handled bu the runner specially, to avoid marking it as an actual error.
   *
   * This is equivalent to `if(isCancelled()) { return; }`
   * */
  exitIfCancelled: () => void;
}
