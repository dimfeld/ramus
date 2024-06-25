import { expect, test } from 'bun:test';

import { DagRunner, runDag } from './runner.js';
import { Dag, DagConfiguration } from './types.js';
import { WorkflowEvent } from '../events.js';
import { runWithEventContext } from '../tracing.js';

interface Context {
  ctxValue: number;
}

function eventCatcher() {
  let events: WorkflowEvent[] = [];
  return {
    eventCb: (e) => events.push(e),
    events,
  };
}

test('simple DAG', async () => {
  const nodes: DagConfiguration<Context, number> = {
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

  const { eventCb, events } = eventCatcher();

  const dag: Dag<Context, number> = {
    name: 'test',
    context: () => ({ ctxValue: 10 }),
    nodes,
  };

  let result = await runDag({ dag, input: 10, context: { ctxValue: 5 }, eventCb });
  // 2 * ((5 + 1) + 1) + 10
  expect(result).toEqual(24);

  const startEvent = events[0];
  expect(startEvent.type).toEqual('dag:start');
  expect(startEvent.step).toBeString();

  const nodeStartEvents = events.filter((e) => e.type === 'dag:node_start');
  expect(nodeStartEvents.length).toEqual(5);

  for (let event of nodeStartEvents) {
    expect(event.data.parent_step).toEqual(startEvent.step);
  }
});

test('running from parent context', async () => {
  const nodes: DagConfiguration<Context, number> = {
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

  const { eventCb, events } = eventCatcher();

  const dag: Dag<Context, number> = {
    name: 'test',
    context: () => ({ ctxValue: 10 }),
    nodes,
  };

  let result = await runWithEventContext(
    {
      parentStep: 'abc',
      currentStep: 'def',
      logEvent: eventCb,
    },
    () => runDag({ dag, input: 10, context: { ctxValue: 5 } })
  );
  // 2 * ((5 + 1) + 1) + 10
  expect(result).toEqual(24);

  const startEvent = events[0];
  expect(startEvent.type).toEqual('dag:start');
  expect(startEvent.step).not.toEqual('abc');
  expect(startEvent.step).not.toEqual('def');
  expect(startEvent.data.parent_step).toEqual('def');

  const nodeStartEvents = events.filter((e) => e.type === 'dag:node_start');
  expect(nodeStartEvents.length).toEqual(5);

  for (let event of nodeStartEvents) {
    expect(event.data.parent_step).toEqual(startEvent.step);
  }
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
    context: () => ({ ctxValue: 10 }),
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

  const dag: Dag<Context, number> = {
    name: 'test',
    context: () => ({ ctxValue: 10 }),
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
    context: () => ({ ctxValue: 10 }),
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
    context: () => ({ ctxValue: 10 }),
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
    context: () => ({ ctxValue: 10 }),
    nodes,
  };

  await expect(runDag({ dag, input: undefined, context: { ctxValue: 5 } })).rejects.toThrowError(
    'failure'
  );
});
