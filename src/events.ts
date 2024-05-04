import type { ChronicleClientOptions, ChronicleRequestMetadata } from 'chronicle-proxy';

export interface WorkflowEvent<DATA, META extends object = {}> {
  type: string;
  data: DATA;
  meta: ChronicleRequestMetadata;
}

export type WorkflowEventCallback<DATA, META extends object = {}> = (
  event: WorkflowEvent<DATA, META>
) => void;
