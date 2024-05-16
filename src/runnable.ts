import { EventEmitter } from 'events';
import { Intervention } from './interventions.js';

export type RunnableEvents<OUTPUT, INTERVENTIONDATA> = {
  intervention: [Intervention<INTERVENTIONDATA>];
  cancelled: [];
  error: [Error];
  finish: [OUTPUT];
} & Record<string, any[]>;

export interface Runnable<
  OUTPUT,
  INTERVENTIONDATA = undefined,
  INTERVENTIONRESPONSE = unknown,
  EVENTS extends RunnableEvents<OUTPUT, INTERVENTIONDATA> = RunnableEvents<
    OUTPUT,
    INTERVENTIONDATA
  >,
> extends EventEmitter<EVENTS> {
  run(): any;
  finished: Promise<OUTPUT>;
  cancel(): void;
  respondToIntervention(id: string, response: INTERVENTIONRESPONSE): void;
}
