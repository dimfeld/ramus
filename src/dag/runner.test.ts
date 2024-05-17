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
      run: async ({ input, rootInput }) => {
        return input.intone + input.inttwo + rootInput;
      },
    },
  };

  const dag: Dag<Context, number> = {
    name: 'test',
    nodes,
  };

  let result = await runDag({ dag, input: 10, context: { ctxValue: 5 } });
  // 2 * ((5 + 1) + 1) + 10
  expect(result).toEqual(24);
});

test('single node', async () => {
  const nodes: DagConfiguration<Context, undefined> = {
    root: {
      run: async ({ context }) => {
        return context.ctxValue + 1;
      },
    },
  };

  const dag: Dag<Context, undefined> = {
    name: 'test',
    nodes,
  };

  let result = await runDag({ dag, input: undefined, context: { ctxValue: 5 } });
  // 2 * ((5 + 1) + 1)
  expect(result).toEqual(6);
});

test('no nodes', async () => {
  const nodes: DagConfiguration<Context, undefined> = {};

  const dag: Dag<Context, undefined> = {
    name: 'test',
    nodes,
  };

  await expect(runDag({ dag, input: undefined, context: { ctxValue: 5 } })).rejects.toThrowError(
    'DAG has no nodes'
  );
});

test('multiple root nodes', async () => {
  const nodes: DagConfiguration<Context, number> = {
    rootOne: {
      run: async ({ context, rootInput }) => {
        return context.ctxValue + rootInput + 1;
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

  let result = await runDag({ dag, input: 10, context: { ctxValue: 5 } });
  expect(result).toEqual(23);
});

test('multiple leaf nodes', async () => {
  const nodes: DagConfiguration<Context, undefined> = {
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

  const dag: Dag<Context, undefined> = {
    name: 'test',
    nodes,
  };

  let result = await runDag({ dag, input: undefined, context: { ctxValue: 5 } });
  expect(result).toEqual({
    outputOne: 7,
    outputTwo: 8,
  });
});

test('node error when tolerating failures', async () => {
  const nodes: DagConfiguration<Context, undefined> = {
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

  const dag: Dag<Context, undefined> = {
    name: 'test',
    nodes,
    tolerateFailures: true,
  };

  let result = await runDag({ dag, input: undefined, context: { ctxValue: 5 } });
  expect(result).toEqual({
    outputOne: undefined,
    outputTwo: 8,
  });
});

test('node error when not tolerating failures', async () => {
  const nodes: DagConfiguration<Context, undefined> = {
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

  const dag: Dag<Context, undefined> = {
    name: 'test',
    nodes,
  };

  await expect(runDag({ dag, input: undefined, context: { ctxValue: 5 } })).rejects.toThrowError(
    'failure'
  );
});
