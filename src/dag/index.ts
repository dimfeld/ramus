import { EventEmitter } from 'events';

export interface DagNodeInput<CONTEXT extends object, INPUTS extends object> {
  context: CONTEXT;
  input: INPUTS;
  cancelled: () => boolean;
}

interface NamedDagNode<CONTEXT extends object, INPUTS extends object, OUTPUT>
  extends DagNode<CONTEXT, INPUTS, OUTPUT> {
  name: string;
}

export interface DagNode<CONTEXT extends object, INPUTS extends object, OUTPUT> {
  parents?: Array<keyof INPUTS>;
  run: (input: DagNodeInput<CONTEXT, INPUTS>) => OUTPUT | Promise<OUTPUT>;
}

export interface Dag<CONTEXT extends object> {
  name: string;
  description?: string;
  nodes: Record<string, DagNode<CONTEXT, object, unknown>>;
}

export type DagConfiguration<CONTEXT extends object> = Record<
  string,
  DagNode<CONTEXT, object, unknown>
>;

export class CompiledDag<CONTEXT extends object> {
  // todo
  constructor(dag: DagConfiguration<CONTEXT>) {
    const { leafNodes, rootNodes } = compileDag(dag);

    let namedNodes: NamedDagNode<CONTEXT, object, unknown>[] = Object.entries(dag).map(
      ([name, node]) => ({
        ...node,
        name,
      })
    );

    // Create a topologically sorted list of nodes
  }
}

export function compileDag(dag: Record<string, DagNode<any, any, any>>) {
  // Start with all nodes potentially being leaf nodes and then exclude them as we go.
  const leafNodes = new Set<string>(Object.keys(dag));

  function step(node: DagNode<object, object, unknown>, seen: string[]) {
    for (let parent of node.parents ?? []) {
      leafNodes.delete(parent);

      if (!dag[parent]) {
        throw new Error(`Node '${seen.at(-1)}' has unknown parent '${parent}'`);
      }

      if (seen.includes(parent)) {
        throw new Error(`Cycle detected: ${seen.join(' -> ')} -> ${parent}`);
      }

      step(dag[parent], [...seen, parent]);
    }
  }

  const rootNodes: string[] = [];
  for (let [name, node] of Object.entries(dag)) {
    if (!node.parents?.length) {
      rootNodes.push(name);
    }

    step(node, [name]);
  }

  return {
    rootNodes,
    leafNodes: [...leafNodes],
  };
}

export interface DagRunnerOptions<CONTEXT extends object> {
  dag: DagConfiguration<CONTEXT> | CompiledDag<CONTEXT>;
  /** Take the workflow name from this object instead of using the DAG name */
  workflow_name?: string;
  /** The workflow ID if it exists. */
  workflow_id?: string;
  /** The ID for the particular workflow run. Automatically generated if not provided. */
  run_id?: string;
  step_index?: number;
}

export class DagRunner<CONTEXT extends object, OUTPUT> extends EventEmitter {
  /** If true, halt on error. If false, continue running any portions of the DAG that were not affected by the error. */
  haltOnError = true;
  context: CONTEXT;
  runners: DagNodeRunner<CONTEXT, object, unknown>[];

  constructor(dag: DagConfiguration<CONTEXT> | CompiledDag<CONTEXT>, initialContext: CONTEXT) {
    super();

    if (!(dag instanceof CompiledDag)) {
      dag = new CompiledDag(dag);
    }

    this.context = initialContext;

    this.runners = dag.buildRunners();

    // Ensure that node names are unique
  }

  /** Run the entire DAG to completion */
  async run(initialContext: CONTEXT): Promise<OUTPUT> {
    // Start running all root nodes
    for (let runner of this.runners) {
      runner.run();
    }
  }
}

export type DagNodeState = 'waiting' | 'running' | 'cancelled' | 'error' | 'finished';

class DagNodeRunner<CONTEXT extends object, INPUTS extends object, OUTPUT> extends EventEmitter {
  name: string;
  runner: DagRunner<CONTEXT, unknown>;
  config: DagNode<CONTEXT, INPUTS, OUTPUT>;
  state: DagNodeState;

  waiting: Set<string>;
  inputs: Map<string, unknown>;

  constructor(
    runner: DagRunner<CONTEXT, unknown>,
    name: string,
    config: DagNode<CONTEXT, INPUTS, OUTPUT>,
    parents: DagNodeRunner<CONTEXT, object, unknown>[]
  ) {
    super();
    this.name = name;
    this.config = config;
    this.runner = runner;
    this.state = 'waiting';

    this.runner.on('cancel', () => {
      if (this.state === 'waiting' || this.state === 'running') {
        this.state = 'cancelled';
      }
    });

    this.waiting = new Set(parents.map((p) => p.name));
    this.inputs = new Map();
    for (let parent of parents) {
      parent.once('finish', (e) => {
        this.waiting.delete(parent.name);
        this.inputs.set(parent.name, e.output);
        this.run();
      });

      parent.once('error', (e) => {
        if (this.state !== 'waiting') {
          return;
        }

        this.state = 'cancelled';
        this.emit('parentError');
      });

      // We distinguish this from a normal error so that it's easier to see which node actually encountered an error and
      // which nodes were affected by it.
      parent.once('parentError', () => {
        if (this.state !== 'waiting') {
          return;
        }

        this.state = 'cancelled';
        this.emit('parentError');
      });
    }
  }

  async run(): Promise<void> {
    if (this.waiting.size > 0 || this.state !== 'waiting') {
      return;
    }

    try {
      this.state = 'running';
      // TODO this is not the correct input type
      let output = await this.config.run({
        context: this.runner.context,
        cancelled: () => this.state === 'cancelled',
        input: this.inputs,
      });
      this.state = 'finished';
      this.emit('finish', { name: this.name, output });
    } catch (e) {
      this.state = 'error';
      this.emit('error', e);
    }

    // wait for all the parents to complete

    // for a parent node:
    //   on finish: then remove the node from the waiting list. If the list is now empty then proceed to
    //   run
    //   on error: emit the parentError event and exit
    //   on parentError: emit the parentError event and exit
  }
}
