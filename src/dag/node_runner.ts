import { EventEmitter } from 'events';
import type { AnyInputs, DagNode, DagNodeState } from './types.js';

export class DagNodeRunner<
  CONTEXT extends object,
  INPUTS extends AnyInputs,
  OUTPUT,
> extends EventEmitter<{
  finish: [{ name: string; output: OUTPUT }];
  error: [Error];
  parentError: [];
}> {
  name: string;
  config: DagNode<CONTEXT, INPUTS, OUTPUT>;
  context: CONTEXT;
  state: DagNodeState;

  waiting: Set<string>;
  inputs: Partial<INPUTS>;

  constructor(name: string, config: DagNode<CONTEXT, INPUTS, OUTPUT>, context: CONTEXT) {
    super();
    this.name = name;
    this.config = config;
    this.context = context;
    this.state = 'waiting';
    this.waiting = new Set();
    this.inputs = {};
  }

  init(
    parents: DagNodeRunner<CONTEXT, AnyInputs, unknown>[],
    cancel: EventEmitter<{ cancel: [] }>
  ) {
    cancel.on('cancel', () => {
      if (this.state === 'waiting' || this.state === 'running') {
        this.state = 'cancelled';
      }
    });

    const handleFinishedParent = (e: { name: string; output: any }) => {
      if (this.state !== 'waiting') {
        return;
      }

      this.waiting.delete(e.name);
      this.inputs[e.name as keyof INPUTS] = e.output;
      this.run();
    };

    const handleParentError = (name: string) => {
      if (this.state !== 'waiting') {
        return;
      }

      if (this.config.tolerateParentErrors) {
        handleFinishedParent({ name, output: undefined });
      } else {
        this.state = 'cancelled';
        // Pass the error down the chain
        this.emit('parentError');
      }
    };

    for (let parent of parents) {
      this.waiting.add(parent.name);

      parent.once('finish', handleFinishedParent);
      parent.once('error', () => handleParentError(parent.name));
      parent.once('parentError', () => handleParentError(parent.name));
    }
  }

  async run(): Promise<void> {
    if (this.waiting.size > 0 || this.state !== 'waiting') {
      return;
    }

    try {
      this.state = 'running';
      let output = await this.config.run({
        context: this.context,
        cancelled: () => this.state === 'cancelled',
        input: this.inputs as INPUTS,
      });
      this.state = 'finished';
      this.emit('finish', { name: this.name, output });
    } catch (e) {
      this.state = 'error';
      this.emit('error', e as Error);
    }

    // wait for all the parents to complete

    // for a parent node:
    //   on finish: then remove the node from the waiting list. If the list is now empty then proceed to
    //   run
    //   on error: emit the parentError event and exit
    //   on parentError: emit the parentError event and exit
  }
}
