import type { ChronicleRequestMetadata } from 'chronicle-proxy';
import { AnyInputs } from './dag/types.js';

/** The general structure of an event emitted by the framework. */
export interface WorkflowEventBase<TYPE extends string, DATA> {
  type: TYPE;
  data: DATA;
  source: string;
  sourceNode: string;
  meta?: ChronicleRequestMetadata;
}

export type DagStartEvent = WorkflowEventBase<'dag:start', { input: unknown }>;
export type DagErrorEvent = WorkflowEventBase<'dag:start', { error: Error }>;
export type DagFinishEvent = WorkflowEventBase<'dag:finish', { output: unknown }>;
export type DagNodeStartEvent = WorkflowEventBase<'dag:node_start', { input: AnyInputs }>;
export type DagNodeFinishEvent = WorkflowEventBase<'dag:node_finish', { output: unknown }>;
export type DagNodeErrorEvent = WorkflowEventBase<'dag:node_error', { error: Error }>;

/** Events emitted by the framework itself. */
export type FrameworkWorkflowEvent =
  | DagStartEvent
  | DagErrorEvent
  | DagFinishEvent
  | DagNodeStartEvent
  | DagNodeFinishEvent
  | DagNodeErrorEvent;

/** Any workflow event, covering any event type */
export type WorkflowEvent = WorkflowEventBase<string, unknown>;

/** Return true if this event is emitted by the framework itself. If false, then this even is from
 * one of the nodes. */
export function isFrameworkEvent(event: WorkflowEvent): event is FrameworkWorkflowEvent {
  return [
    'dag:start',
    'dag:finish',
    'dag:error',
    'dag:node_start',
    'dag:node_finish',
    'dag:node_error',
  ].includes(event.type);
}

export type WorkflowEventCallback = (event: WorkflowEvent) => any;
