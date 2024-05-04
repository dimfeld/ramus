import { EventEmitter } from 'events';
import { AnyInputs, DagConfiguration, DagNode } from './types.js';
import { DagNodeRunner } from './node_runner.js';

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

export class CompiledDag<CONTEXT extends object, OUTPUT> {
  info: ReturnType<typeof compileDag>;

  namedNodes: NamedDagNode<CONTEXT, AnyInputs, unknown>[];
  constructor(dag: DagConfiguration<CONTEXT>) {
    this.info = compileDag(dag);
    this.namedNodes = Object.entries(dag).map(([name, node]) => ({
      ...node,
      name,
    }));
  }

  buildRunners(context: CONTEXT) {
    const cancel = new EventEmitter<{ cancel: [] }>();

    let nodes = new Map<string, DagNodeRunner<CONTEXT, AnyInputs, unknown>>();

    for (let node of this.namedNodes) {
      const runner = new DagNodeRunner(node.name, node, context);
      nodes.set(node.name, runner);
    }

    for (let node of nodes.values()) {
      let parents = node.config.parents?.map((name) => nodes.get(name)!) ?? [];
      node.init(parents, cancel);
    }

    let leafRunners = this.info.leafNodes.map((name) => nodes.get(name)!);

    const outputNode = new DagNodeRunner<CONTEXT, AnyInputs, OUTPUT>(
      '__output',
      {
        parents: this.info.leafNodes,
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
