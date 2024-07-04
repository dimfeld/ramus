import { expect, test } from 'bun:test';

import { DagRunner, runDag } from './runner.js';
import { Dag, DagConfiguration } from './types.js';
import { startRun, createChronicleClient, ChronicleEvent, RunStartEvent, StepStartEvent } from '@dimfeld/chronicle';

interface Context {
  ctxValue: number;
}

function eventCatcher() {
  let events: ChronicleEvent[] = [];
  let chronicle = createChronicleClient();
  chronicle.on('event', (e) => events.push(e));
  return {
    chronicle,
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

  const { chronicle, events } = eventCatcher();

  const { id: runId } = await startRun(
    {
      chronicle,
    },
    async () => {
      const dag: Dag<Context, number> = {
        name: 'test',
        context: () => ({ ctxValue: 10 }),
        nodes,
        tags: ['test-dag']
      };

      let result = await runDag({ dag, input: 10, context: { ctxValue: 5 }, chronicle });
      // 2 * ((5 + 1) + 1) + 10
      expect(result).toEqual(24);
    }
  );

  const startEvent = events[0] as RunStartEvent;
  expect(startEvent.type).toEqual('run:start');
  expect(startEvent.id).toEqual(runId);

  const nodeStartEvents = events.filter((e) => e.type === 'step:start') as StepStartEvent[];
  // A step for each of the 5 nodes, plus the first step for the entire DAG
  expect(nodeStartEvents.length).toEqual(6);

  const dagStartEvent = nodeStartEvents[0];
  expect(dagStartEvent.run_id).toEqual(runId);
  expect(dagStartEvent.data.name).toEqual('test');
  expect(dagStartEvent.data.parent_step).toBeUndefined();
  expect(dagStartEvent.data.tags).toEqual(['test-dag']);

  for (let event of nodeStartEvents.slice(1)) {
    expect(event.data.parent_step).toEqual(dagStartEvent.step_id!);
    expect(event.run_id).toEqual(runId)
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
    context: () => ({ ctxValue: 10 }),
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
