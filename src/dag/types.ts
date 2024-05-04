export type DagNodeState = 'waiting' | 'running' | 'cancelled' | 'error' | 'finished';

export interface DagNodeInput<CONTEXT extends object, INPUTS extends AnyInputs> {
  context: CONTEXT;
  input: INPUTS;
  cancelled: () => boolean;
}

export type AnyInputs = Record<string, unknown>;

export interface DagNode<CONTEXT extends object, INPUTS extends AnyInputs, OUTPUT> {
  parents?: Array<keyof INPUTS>;
  /** If true, run this node even if one of its parents has an error. */
  tolerateParentErrors?: boolean;
  run: (input: DagNodeInput<CONTEXT, INPUTS>) => OUTPUT | Promise<OUTPUT>;
}

export interface Dag<CONTEXT extends object> {
  name: string;
  description?: string;
  nodes: DagConfiguration<CONTEXT>;
}

export type DagConfiguration<CONTEXT extends object> = Record<
  string,
  DagNode<CONTEXT, AnyInputs, unknown>
>;
