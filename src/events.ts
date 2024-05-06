import type { ChronicleRequestMetadata } from 'chronicle-proxy';

// TODO better event types
export interface WorkflowEvent<DATA> {
  type: string;
  source: string;
  sourceNode: string;
  data: DATA;
  meta?: ChronicleRequestMetadata;
}

export type WorkflowEventCallback<DATA> = (event: WorkflowEvent<DATA>) => any;
