import { EventEmitter } from 'events';

export type RunnableEvents<OUTPUT> = {
  cancelled: [];
  // We use this instead of 'error' because an unhandled 'error' emit will crash the process, but we have multiple ways
  // of handling errors so don't necessarily need the user to handle 'error'.
  'ramus:error': [{ error: Error; fatal?: boolean }];
  finish: [OUTPUT];
} & Record<string, any[]>;

export interface Runnable<OUTPUT, EVENTS extends RunnableEvents<OUTPUT> = RunnableEvents<OUTPUT>>
  extends EventEmitter<EVENTS> {
  run(): any;
  finished: Promise<OUTPUT>;
  cancel(): void;
}
