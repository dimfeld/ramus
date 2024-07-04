import { Span } from '@opentelemetry/api';

export interface NodeInput<CONTEXT extends object, ROOTINPUT, INPUTS> {
  /** The context passed to the DAG by whatever started it. */
  context: CONTEXT;
  /** Inputs from the node's parents */
  input: INPUTS;
  /** Input from the code that spawned this DAG */
  rootInput: ROOTINPUT;
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
}
