import { EventEmitter } from 'events';
import { ChronicleClient, ChronicleClientOptions, createChronicleClient } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';

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
  info: ReturnType<typeof compileDag>;

  namedNodes: NamedDagNode<CONTEXT, object, unknown>[];
  constructor(dag: DagConfiguration<CONTEXT>) {
    this.info = compileDag(dag);
    this.namedNodes = Object.entries(dag).map(([name, node]) => ({
      ...node,
      name,
    }));
  }

  buildRunners(context: CONTEXT) {
    const cancel = new EventEmitter<{ cancel: [] }>();

    let nodes = new Map<string, DagNodeRunner<CONTEXT, object, unknown>>();

    for (let node of this.namedNodes) {
      const runner = new DagNodeRunner(node.name, node, context);
      nodes.set(node.name, runner);
    }

    for (let node of nodes.values()) {
      let parents = node.config.parents?.map((name) => nodes.get(name)!) ?? [];
      node.init(parents, cancel);
    }

    let leafRunners = this.info.leafNodes.map((name) => nodes.get(name)!);

    const outputNode = new DagNodeRunner(
      '__output',
      {
        parents: this.info.leafNodes,
        run: ({ input }) => input,
      },
      context
    );

    outputNode.init(leafRunners, cancel);

    return {
      runners: [...nodes.values()],
      outputNode,
      cancel,
    };
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
  /** Options for a Chronicle LLM proxy client */
  chronicle?: ChronicleClientOptions;
  /** A function that can take events from the running DAG */
  event?: WorkflowEventCallback<unknown>;
}

export class DagRunner<CONTEXT extends object, OUTPUT> {
  /** If true, halt on error. If false, continue running any portions of the DAG that were not affected by the error. */
  haltOnError = true;
  context: CONTEXT;
  runners: DagNodeRunner<CONTEXT, object, unknown>[];
  outputNode: DagNodeRunner<CONTEXT, object, OUTPUT>;
  cancel: EventEmitter<{ cancel: [] }>;

  constructor(dag: DagConfiguration<CONTEXT> | CompiledDag<CONTEXT>, context: CONTEXT) {
    if (!(dag instanceof CompiledDag)) {
      dag = new CompiledDag(dag);
    }

    this.context = context;
    const { runners, outputNode, cancel } = dag.buildRunners(context);

    this.runners = runners;
    this.cancel = cancel;
    this.outputNode = outputNode;
  }

  /** Run the entire DAG to completion */
  run(initialContext: CONTEXT): Promise<OUTPUT> {
    return new Promise((resolve, reject) => {
      for (let runner of this.runners) {
        runner.on('error', (e) => {
          this.cancel.emit('cancel');
          reject(e);
        });

        this.outputNode.on('error', (e) => {
          this.cancel.emit('cancel');
          reject(e);
        });
      }

      // TODO output Node needs a different runner that can emit a partial event if some of the
      // nodes had errors
      this.outputNode.on('finish', (e) => {
        resolve(e.output);
      });
      this.outputNode.run();

      // Start running all root nodes
      for (let runner of this.runners) {
        runner.run();
      }
    });
  }
}

export type DagNodeState = 'waiting' | 'running' | 'cancelled' | 'error' | 'finished';

class DagNodeRunner<CONTEXT extends object, INPUTS extends object, OUTPUT> extends EventEmitter<{
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

  init(parents: DagNodeRunner<CONTEXT, object, unknown>[], cancel: EventEmitter<{ cancel: [] }>) {
    cancel.on('cancel', () => {
      if (this.state === 'waiting' || this.state === 'running') {
        this.state = 'cancelled';
      }
    });

    const handleFinishedParent = (e: { name: string; output: any }) => {
      this.waiting.delete(e.name);
      this.inputs[e.name as keyof INPUTS] = e.output;
      this.run();
    };

    const handleError = () => {
      if (this.state !== 'waiting') {
        return;
      }

      this.state = 'cancelled';
      // Pass the error down the chain
      this.emit('parentError');
    };

    for (let parent of parents) {
      this.waiting.add(parent.name);

      parent.once('finish', handleFinishedParent);
      parent.once('error', handleError);
      parent.once('parentError', handleError);
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
        // TODO this is not the correct input type
        input: this.inputs,
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
