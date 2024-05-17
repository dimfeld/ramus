import { EventEmitter } from 'events';

export type RunnableEvents<OUTPUT> = {
  cancelled: [];
  error: [Error];
  finish: [OUTPUT];
} & Record<string, any[]>;

export interface Runnable<OUTPUT, EVENTS extends RunnableEvents<OUTPUT> = RunnableEvents<OUTPUT>>
  extends EventEmitter<EVENTS> {
  run(): any;
  finished: Promise<OUTPUT>;
  cancel(): void;
}
