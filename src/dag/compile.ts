import { EventEmitter } from 'events';
import { AnyInputs, Dag, DagNode } from './types.js';
import { DagNodeRunner } from './node_runner.js';
import { ChronicleClientOptions } from 'chronicle-proxy';
import { WorkflowEventCallback } from '../events.js';

export function compileDag(dag: Record<string, DagNode<any, any, any>>) {
  // Start with all nodes potentially being leaf nodes and then exclude them as we go.
  const leafNodes = new Set<string>(Object.keys(dag));

  function step(node: DagNode<object, AnyInputs, unknown>, seen: string[]) {
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

interface NamedDagNode<CONTEXT extends object, INPUTS extends AnyInputs, OUTPUT>
  extends DagNode<CONTEXT, INPUTS, OUTPUT> {
  name: string;
}

export interface BuildRunnerOptions<CONTEXT extends object> {
  context: CONTEXT;
  chronicle?: ChronicleClientOptions;
  eventCb: WorkflowEventCallback<unknown>;
}

export class CompiledDag<CONTEXT extends object, OUTPUT> {
  config: Dag<CONTEXT>;
  info: ReturnType<typeof compileDag>;

  namedNodes: NamedDagNode<CONTEXT, AnyInputs, unknown>[];
  constructor(dag: Dag<CONTEXT>) {
    this.config = dag;
    this.info = compileDag(dag.nodes);
    this.namedNodes = Object.entries(dag.nodes).map(([name, node]) => ({
      ...node,
      name,
    }));

    if (!this.namedNodes.length) {
      throw new Error('DAG has no nodes');
    }
  }

  buildRunners({ context, chronicle, eventCb }: BuildRunnerOptions<CONTEXT>) {
    const cancel = new EventEmitter<{ cancel: [] }>();

    let nodes = new Map<string, DagNodeRunner<CONTEXT, AnyInputs, unknown>>();

    for (let node of this.namedNodes) {
      const runner = new DagNodeRunner({
        name: node.name,
        dagName: this.config.name,
        config: node,
        context,
        chronicle,
        eventCb,
      });
      nodes.set(node.name, runner);
    }

    for (let node of nodes.values()) {
      let parents = node.config.parents?.map((name) => nodes.get(name)!) ?? [];
      node.init(parents, cancel);
    }

    let leafRunners = this.info.leafNodes.map((name) => nodes.get(name)!);

    const outputNode = new DagNodeRunner<CONTEXT, AnyInputs, OUTPUT>({
      name: '__output',
      dagName: this.config.name,
      config: {
        parents: this.info.leafNodes,
        tolerateParentErrors: true,
        run: ({ input }) => {
          if (input) {
            let keys = Object.keys(input);
            if (keys.length === 1) {
              return input[keys[0]] as OUTPUT;
            }
          }

          return input as OUTPUT;
        },
      },
      context,
      chronicle,
      eventCb,
    });

    outputNode.init(leafRunners, cancel);

    return {
      runners: [...nodes.values()],
      outputNode,
      cancel,
    };
  }
}
