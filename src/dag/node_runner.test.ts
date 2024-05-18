import { test, describe, expect } from 'bun:test';
import { EventEmitter } from 'events';
import { DagNodeRunner } from './node_runner';
import { LocalSemaphore } from '../semaphore';

function outputCatcher(runner: DagNodeRunner<any, any, any, any>) {
  let finished = false;
  const promise = new Promise((resolve, reject) => {
    runner.on('finish', (d) => {
      finished = true;
      resolve(d);
    });

    runner.on('parentError', () => {
      finished = true;
      reject(new Error('parentError'));
    });

    runner.on('error', (e) => {
      finished = true;
      reject(e);
    });
  });

  return {
    promise,
    finished: () => finished,
  };
}

/** A mock runner used as inputs to the runner under test */
function mockRunner(name: string, output: any, fail = false) {
  const runner = new DagNodeRunner({
    name: name,
    dagName: name,
    config: {
      run: async () => {
        if (fail) {
          throw new Error('Parent node failed');
        }
        return output;
      },
    },
    rootInput: {},
    context: {} as any,
    eventCb: () => {},
  });
  runner.init([]);
  return runner;
}

test('no parents', async () => {
  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    config: { run: ({ context }) => context.value + 1 },
    rootInput: {},
    context: { value: 1 },
    eventCb: () => {},
  });
  const { promise, finished } = outputCatcher(runner);

  runner.init([]);

  // should be waiting before we started trying to run it
  expect(runner.state).toBe('waiting');
  expect(finished()).toBe(false);

  let ran = await runner.run();
  expect(ran).toBe(true);

  let result = await promise;
  expect(result).toEqual({ name: 'node', output: 2 });
  expect(runner.state).toBe('finished');
  expect(runner.result).toEqual({ type: 'success', output: 2 });
});

test('single parent', async () => {
  let parent = mockRunner('parent', 2);
  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    rootInput: {},
    config: { parents: ['parent'], run: ({ context, input }) => input.parent + context.value + 1 },
    context: { value: 1 },
    eventCb: () => {},
  });

  const { promise, finished } = outputCatcher(runner);

  runner.init([parent]);

  // should be waiting before we started trying to run it
  expect(runner.state).toBe('waiting');
  expect(finished()).toBe(false);

  // parent hasn't run yet
  let ranAtStart = await runner.run();
  expect(ranAtStart).toBe(false);
  expect(runner.state).toBe('waiting');
  expect(finished()).toBe(false);

  await parent.run();
  let result = await promise;
  expect(result).toEqual({ name: 'node', output: 4 });
  expect(runner.state).toBe('finished');
  expect(runner.result).toEqual({ type: 'success', output: 4 });
});

test('multiple parents', async () => {
  const parents = [1, 2, 3, 4].map((i) => mockRunner(`parent${i}`, i));
  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    config: {
      parents: parents.map((p) => p.name),
      run: async ({ context, input }) =>
        input.parent1 + input.parent2 + input.parent3 + input.parent4 + context.value,
    },
    rootInput: {},
    context: { value: 10 },
    eventCb: () => {},
  });

  const { promise, finished } = outputCatcher(runner);

  runner.init(parents);

  // Run most but not all of the parents.
  await Promise.all([parents[0].run(), parents[2].run(), parents[3].run()]);

  let ranAtStart = await runner.run();
  expect(ranAtStart).toBe(false);
  expect(runner.state).toBe('waiting');
  expect(finished()).toBe(false);

  await parents[1].run();

  let result = await promise;
  expect(result).toEqual({ name: 'node', output: 20 });
  expect(runner.state).toBe('finished');
  expect(runner.result).toEqual({ type: 'success', output: 20 });
});

test('parent failed when errors are not tolerated', async () => {
  let successParent = mockRunner('successParent', 1);
  let failParent = mockRunner('failParent', 1, true);

  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    config: {
      parents: ['successParent', 'failParent'],
      run: async () => 1,
    },
    rootInput: {},
    context: { value: 10 },
    eventCb: () => {},
  });

  let sawParentError = false;
  runner.on('parentError', () => {
    sawParentError = true;
  });

  let { promise, finished } = outputCatcher(runner);

  runner.init([successParent, failParent]);

  failParent.run();

  expect(async () => promise).toThrow('parentError');
  expect(runner.state).toBe('cancelled');
  expect(runner.result).toBeUndefined();
  expect(finished()).toBe(true);
  expect(sawParentError).toBe(true);

  await successParent.run();
  expect(runner.state).toBe('cancelled');
});

test('tolerate parent errors', async () => {
  let successParent = mockRunner('successParent', 5);
  let failParent = mockRunner('failParent', 8, true);

  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    config: {
      parents: ['successParent', 'failParent'],
      tolerateParentErrors: true,
      run: async ({ input }) => {
        return input.successParent + (input.failParent ?? 0) + 1;
      },
    },
    rootInput: {},
    context: { value: 10 },
    eventCb: () => {},
  });

  let { promise, finished } = outputCatcher(runner);

  runner.init([successParent, failParent]);

  await failParent.run().catch(() => {});
  await successParent.run();

  let result = await promise;
  expect(result).toEqual({ name: 'node', output: 6 });
  expect(runner.state).toBe('finished');
  expect(runner.result).toEqual({ type: 'success', output: 6 });
  expect(finished()).toBe(true);
});

test('tolerate parent errors, when all parents error', async () => {
  let failParent1 = mockRunner('failParent1', 5, true);
  let failParent2 = mockRunner('failParent2', 8, true);

  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    config: {
      parents: ['failParent1', 'failParent2'],
      tolerateParentErrors: true,
      run: async ({ input }) => {
        return (input.failParent1 ?? 0) + (input.failParent2 ?? 0) + 2;
      },
    },
    rootInput: {},
    context: { value: 10 },
    eventCb: () => {},
  });

  let { promise, finished } = outputCatcher(runner);

  runner.init([failParent1, failParent2]);

  failParent1.run().catch(() => {});
  failParent2.run().catch(() => {});

  let result = await promise;
  // We should have run anyway, despite none of the parents finishing.
  expect(result).toEqual({ name: 'node', output: 2 });
  expect(runner.state).toBe('finished');
  expect(runner.result).toEqual({ type: 'success', output: 2 });
  expect(finished()).toBe(true);
});

test('manual run', async () => {
  let parent = mockRunner('parent', 2);
  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    rootInput: {},
    config: { parents: ['parent'], run: ({ context, input }) => input.parent + context.value + 1 },
    context: { value: 1 },
    eventCb: () => {},
    autorun: () => false,
  });

  const { promise, finished } = outputCatcher(runner);

  runner.init([parent]);

  // should be waiting before we started trying to run it
  expect(runner.state).toBe('waiting');
  expect(finished()).toBe(false);

  // Try to run without parent being ready
  let ranAtStart = await runner.run();
  expect(ranAtStart).toBe(false);
  expect(runner.state).toBe('waiting');
  expect(finished()).toBe(false);

  // The parent runs, but since autorun is off, our test node should be ready, but not run yet.
  await parent.run();
  expect(runner.state).toBe('ready');
  expect(finished()).toBe(false);

  let ranAfterParent = await runner.run();
  expect(ranAfterParent).toBe(true);
  let result = await promise;
  expect(result).toEqual({ name: 'node', output: 4 });
  expect(runner.state).toBe('finished');
  expect(runner.result).toEqual({ type: 'success', output: 4 });
});

test('with semaphores', async () => {
  let semaphore = new LocalSemaphore({ key: 0 });
  let ran = false;
  let runner = new DagNodeRunner({
    name: 'node',
    dagName: 'node',
    semaphores: [semaphore],
    config: {
      semaphoreKey: 'key',
      run: ({ context }) => {
        ran = true;
        return context.value + 1;
      },
    },
    rootInput: {},
    context: { value: 1 },
    eventCb: () => {},
  });
  const { promise, finished } = outputCatcher(runner);

  runner.init([]);

  // should be waiting before we started trying to run it
  expect(runner.state).toBe('waiting');
  expect(finished()).toBe(false);

  let runPromise = runner.run();
  expect(ran).toBe(false);
  expect(finished()).toBe(false);

  semaphore.setLimit('key', 1);
  await runPromise;

  let result = await promise;
  expect(result).toEqual({ name: 'node', output: 2 });
  expect(runner.state).toBe('finished');
  expect(runner.result).toEqual({ type: 'success', output: 2 });
});

test.todo('exitIfCancelled', async () => {});

test.todo('cancel before run', async () => {});

test.todo('cancel during run', async () => {});

test.todo('cancel after finish', async () => {});
