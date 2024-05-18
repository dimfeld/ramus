import { describe, test, expect } from 'bun:test';
import { StateMachineRunner } from './runner.js';
import type { StateMachine } from './types.js';
import { WorkflowEvent } from '../events.js';

test('regular state machine', async () => {
  const config: StateMachine<{ value: number }, number> = {
    name: 'test',
    initial: 'start',
    context: () => ({ value: 1 }),
    nodes: {
      start: {
        run: async ({ context, rootInput }) => {
          context.value += 1;
          return rootInput;
        },
        transition: 'one',
      },
      one: {
        run: async ({ context, input }) => {
          context.value += 1;
          return input * 2;
        },
        transition: {
          '': [{ state: 'two', condition: ({ context }) => context.value < 6 }, { state: 'done' }],
        },
      },
      two: {
        run: async ({ context, input }) => {
          context.value += 1;
          return input * 3;
        },
        transition: 'one',
      },
      done: {
        final: true,
      },
    },
  };

  const events: WorkflowEvent[] = [];
  const machine = new StateMachineRunner({
    config,
    input: 1,
    eventCb: (e) => events.push(e),
  });

  await machine.step();
  expect(machine.canStep()).toBe(true);
  expect(machine.state).toBe('one');
  expect(machine.machineStatus).toBe('ready');
  expect(machine.currentState.input).toBe(1);

  await machine.run();
  expect(machine.canStep()).toBe(false);
  expect(machine.state).toBe('done');
  expect(machine.machineStatus).toBe('final');
  expect(machine.currentState.input).toBe(72);
});

test('cancellation', async () => {
  let cancel: Function;
  const config: StateMachine<{ value: number }, number> = {
    name: 'test',
    initial: 'start',
    context: () => ({ value: 1 }),
    nodes: {
      start: {
        run: async ({ context, rootInput }) => {
          context.value += 1;
          return rootInput;
        },
        transition: 'one',
      },
      one: {
        run: async ({ context, input }) => {
          context.value += 1;
          return input * 2;
        },
        transition: {
          '': [{ state: 'two', condition: ({ context }) => context.value < 6 }, { state: 'done' }],
        },
      },
      two: {
        run: async ({ context, input }) => {
          context.value += 1;
          cancel();
          return input * 3;
        },
        transition: 'one',
      },
      done: {
        final: true,
      },
    },
  };

  const machine = new StateMachineRunner({
    config,
    input: 1,
  });

  cancel = () => machine.cancel();

  await machine.run();
  expect(machine.canStep()).toBe(false);
  expect(machine.state).toBe('one');
  expect(machine.machineStatus).toBe('cancelled');
});

test('error without error state', async () => {
  const config: StateMachine<{ value: number }, number> = {
    name: 'test',
    initial: 'start',
    context: () => ({ value: 1 }),
    nodes: {
      start: {
        run: async ({ context, rootInput }) => {
          context.value += 1;
          return rootInput;
        },
        transition: 'one',
      },
      one: {
        run: async ({ context, input }) => {
          context.value += 1;
          return input * 2;
        },
        transition: {
          '': [{ state: 'two', condition: ({ context }) => context.value < 6 }, { state: 'done' }],
        },
      },
      two: {
        run: async ({ context, input }) => {
          context.value += 1;
          return Promise.reject(new Error('error'));
        },
        transition: 'one',
      },
      done: {
        final: true,
      },
    },
  };

  const machine = new StateMachineRunner({
    config,
    input: 1,
  });

  // Bun will fail the test if we don't handle this
  machine.on('error', () => {});

  await machine.run();
  // We should be stopped at the failed state.
  expect(machine.canStep()).toBe(true);
  expect(machine.state).toBe('two');
  expect(machine.machineStatus).toBe('error');
});

test('error state', async () => {
  const config: StateMachine<{ value: number }, number> = {
    name: 'test',
    initial: 'start',
    errorState: 'errored',
    context: () => ({ value: 1 }),
    nodes: {
      start: {
        run: async ({ context, rootInput }) => {
          context.value += 1;
          return rootInput;
        },
        transition: 'one',
      },
      one: {
        run: async ({ context, input }) => {
          context.value += 1;
          return input * 2;
        },
        transition: {
          '': [{ state: 'two', condition: ({ context }) => context.value < 6 }, { state: 'done' }],
        },
      },
      two: {
        run: async ({ context, input }) => {
          context.value += 1;
          throw new Error('error');
        },
        transition: 'one',
      },
      errored: {
        final: true,
      },
      done: {
        final: true,
      },
    },
  };

  const machine = new StateMachineRunner({
    config,
    input: 1,
  });

  // Bun will fail the test if we don't handle this
  machine.on('error', () => {});

  await machine.run();
  expect(machine.canStep()).toBe(false);
  expect(machine.state).toBe('errored');
  expect(machine.machineStatus).toBe('error');
});

test.todo('semaphores');

test('state without run function', async () => {
  const config: StateMachine<{ value: number }, number> = {
    name: 'test',
    initial: 'start',
    context: () => ({ value: 1 }),
    nodes: {
      start: {
        run: async ({ context, rootInput }) => {
          context.value += 1;
          return rootInput;
        },
        transition: 'one',
      },
      one: {
        run: async ({ context, input }) => {
          context.value += 1;
          return input * 2;
        },
        transition: 'two',
      },
      two: {
        run: async ({ context, input }) => {
          context.value += 1;
          return input * 3;
        },
        transition: 'reroute',
      },
      reroute: {
        transition: {
          '': [{ state: 'one', condition: ({ context }) => context.value < 6 }, { state: 'done' }],
        },
      },
      done: {
        final: true,
      },
    },
  };

  const events: WorkflowEvent[] = [];
  const machine = new StateMachineRunner({
    config,
    input: 1,
    eventCb: (e) => events.push(e),
  });

  await machine.run();
  expect(machine.canStep()).toBe(false);
  expect(machine.state).toBe('done');
  expect(machine.machineStatus).toBe('final');
  expect(machine.context.value).toBe(6);
});

describe('events', () => {
  test.todo('event needed from initial state');
  test.todo('events sent while running get queued up and handled later');
  test.todo('event causes a step');
  test.todo('event does not cause a step');
});

describe('validation', () => {
  test.todo('simple transition references invalid state');
  test.todo('complex transition references invalid state');
  test.todo('initial state does not exist');
  test.todo('error state does not exist');
});
