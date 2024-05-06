import { expect, test } from 'bun:test';

import { DagRunner, runDag } from './runner.js';
import { Dag, DagConfiguration } from './types.js';

interface Context {
  ctxValue: number;
}

test('simple DAG', async () => {
  const nodes: DagConfiguration<Context> = {
    root: {
      run: async ({ context }) => {
        return context.ctxValue + 1;
      },
    },
    intone: {
      parents: ['root'],
      run: async ({ input }) => {
        return input.root + 1;
      },
    },
    inttwo: {
      parents: ['root'],
      run: async ({ input }) => {
        return input.root + 1;
      },
    },
    collector: {
      parents: ['intone', 'inttwo'],
      run: async ({ input }) => {
        return input.intone + input.inttwo;
      },
    },
  };

  const dag: Dag<Context> = {
    name: 'test',
    nodes,
  };

  let result = await runDag({ dag, context: { ctxValue: 5 } });
  // 2 * ((5 + 1) + 1)
  expect(result).toEqual(14);
});

test('single node', async () => {
  const nodes: DagConfiguration<Context> = {
    root: {
      run: async ({ context }) => {
        return context.ctxValue + 1;
      },
    },
  };

  const dag: Dag<Context> = {
    name: 'test',
    nodes,
  };

  let result = await runDag({ dag, context: { ctxValue: 5 } });
  // 2 * ((5 + 1) + 1)
  expect(result).toEqual(6);
});

test('no nodes', async () => {
  const nodes: DagConfiguration<Context> = {};

  const dag: Dag<Context> = {
    name: 'test',
    nodes,
  };

  await expect(runDag({ dag, context: { ctxValue: 5 } })).rejects.toThrowError('DAG has no nodes');
});

test('multiple root nodes', async () => {
  const nodes: DagConfiguration<Context> = {
    rootOne: {
      run: async ({ context }) => {
        return context.ctxValue + 1;
      },
    },
    rootTwo: {
      run: async ({ context }) => {
        return context.ctxValue + 2;
      },
    },
    output: {
      parents: ['rootOne', 'rootTwo'],
      run: async ({ input }) => {
        return input.rootOne + input.rootTwo;
      },
    },
  };

  const dag: Dag<Context> = {
    name: 'test',
    nodes,
  };

  let result = await runDag({ dag, context: { ctxValue: 5 } });
  expect(result).toEqual(13);
});

test('multiple leaf nodes', async () => {
  const nodes: DagConfiguration<Context> = {
    root: {
      run: async ({ context }) => {
        return context.ctxValue + 1;
      },
    },
    outputOne: {
      parents: ['root'],
      run: async ({ input }) => {
        return input.root + 1;
      },
    },
    outputTwo: {
      parents: ['root'],
      run: async ({ input }) => {
        return input.root + 2;
      },
    },
  };

  const dag: Dag<Context> = {
    name: 'test',
    nodes,
  };

  let result = await runDag({ dag, context: { ctxValue: 5 } });
  expect(result).toEqual({
    outputOne: 7,
    outputTwo: 8,
  });
});

test('node error when tolerating failures', async () => {
  const nodes: DagConfiguration<Context> = {
    root: {
      run: async ({ context }) => {
        return context.ctxValue + 1;
      },
    },
    outputOne: {
      parents: ['root'],
      run: async ({ input }) => {
        throw new Error('failure');
      },
    },
    outputTwo: {
      parents: ['root'],
      run: async ({ input }) => {
        return input.root + 2;
      },
    },
  };

  const dag: Dag<Context> = {
    name: 'test',
    nodes,
    tolerateFailures: true,
  };

  let result = await runDag({ dag, context: { ctxValue: 5 } });
  expect(result).toEqual({
    outputOne: undefined,
    outputTwo: 8,
  });
});

test('node error when not tolerating failures', async () => {
  const nodes: DagConfiguration<Context> = {
    root: {
      run: async ({ context }) => {
        return context.ctxValue + 1;
      },
    },
    outputOne: {
      parents: ['root'],
      run: async ({ input }) => {
        throw new Error('failure');
      },
    },
    outputTwo: {
      parents: ['root'],
      run: async ({ input }) => {
        return input.root + 2;
      },
    },
  };

  const dag: Dag<Context> = {
    name: 'test',
    nodes,
  };

  await expect(runDag({ dag, context: { ctxValue: 5 } })).rejects.toThrowError('failure');
});
