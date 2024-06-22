import type { ChronicleRequestMetadata } from 'chronicle-proxy';
import { AnyInputs, DagNodeState } from './dag/types.js';
import { StateMachineStatus } from './state_machine/types.js';

/** The general structure of an event emitted by the framework. */
export interface WorkflowEventBase<TYPE extends string, DATA> {
  type: TYPE;
  data: DATA;
  source: string;
  /** A UUIDv7 for the source workflow */
  sourceId: string;
  /** The node within the workflow that this event belongs to */
  sourceNode: string;
  /** A UUIDv7 identifying the step the event belongs to */
  step?: string;
  meta?: ChronicleRequestMetadata;
  start_time?: Date;
  end_time?: Date;
}

export type DagStartEvent = WorkflowEventBase<
  'dag:start',
  { input: unknown; parent_step: string | null }
>;
export type DagErrorEvent = WorkflowEventBase<'dag:error', { error: Error }>;
export type DagFinishEvent = WorkflowEventBase<'dag:finish', { output: unknown }>;
export type DagNodeStartEvent = WorkflowEventBase<
  'dag:node_start',
  { parent_step: string; input: AnyInputs }
>;
export type DagNodeFinishEvent = WorkflowEventBase<'dag:node_finish', { output: unknown }>;
export type DagNodeErrorEvent = WorkflowEventBase<'dag:node_error', { error: Error }>;
export type DagNodeStateEvent = WorkflowEventBase<'dag:node_state', { state: DagNodeState }>;

/** Starting a generic type of step implemented by the agent itself. */
export type StepStartEvent = WorkflowEventBase<
  'step:start',
  { parent_step: string | null; step_type: string; input: unknown }
>;
export type StepEndEvent = WorkflowEventBase<'step:end', { output: unknown }>;

export type StateMachineStartEvent = WorkflowEventBase<
  'state_machine:start',
  { parent_step: string | null; input: unknown }
>;
export type StateMachineStatusEvent = WorkflowEventBase<
  'state_machine:status',
  { status: StateMachineStatus }
>;
export type StateMachineNodeStartEvent = WorkflowEventBase<
  'state_machine:node_start',
  {
    input: unknown;
    parent_step: string;
    event?: {
      type: string;
      data: unknown;
    };
  }
>;
export type StateMachineNodeFinishEvent = WorkflowEventBase<
  'state_machine:node_finish',
  {
    output: unknown;
  }
>;
export type StateMachineTransitionEvent = WorkflowEventBase<
  'state_machine:transition',
  {
    event: string;
    eventData: unknown;
    input: unknown;
    output: unknown;
    from: string;
    to: string;
    final: boolean;
  }
>;

/** Events emitted by the framework itself. */
export type FrameworkWorkflowEvent =
  | DagStartEvent
  | DagErrorEvent
  | DagFinishEvent
  | DagNodeStartEvent
  | DagNodeFinishEvent
  | DagNodeErrorEvent
  | DagNodeStateEvent
  | StateMachineStartEvent
  | StateMachineStatusEvent
  | StateMachineNodeStartEvent
  | StateMachineNodeFinishEvent
  | StateMachineTransitionEvent
  | StepStartEvent
  | StepEndEvent;

/** Any workflow event, covering any event type */
export type WorkflowEvent = WorkflowEventBase<string, unknown>;

const frameworkEvents = new Set([
  'dag:start',
  'dag:finish',
  'dag:error',
  'dag:node_start',
  'dag:node_finish',
  'dag:node_error',
  'dag:node_state',
  'state_machine:start',
  'state_machine:status',
  'state_machine:transition',
  'state_machine:node_start',
  'state_machine:node_finish',
  'step:start',
  'step:end',
]);

/** Return true if this event is emitted by the framework itself. If false, then this event is from
 * one of the nodes. */
export function isFrameworkEvent(event: WorkflowEvent): event is FrameworkWorkflowEvent {
  return frameworkEvents.has(event.type);
}

export type WorkflowEventCallback = (event: WorkflowEvent) => any;
