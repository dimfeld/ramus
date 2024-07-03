import { describe, test, expect } from 'bun:test';
import { StateMachineRunner } from './runner.js';
import type { StateMachine } from './types.js';
import {
  ChronicleEvent,
  StepStartEvent,
  createChronicleClient,
  runStep,
  startRun,
} from '@dimfeld/chronicle';

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

  const events: ChronicleEvent[] = [];
  const chronicle = createChronicleClient();
  chronicle.on('event', (e) => events.push(e));

  const { id: runId } = await startRun(
    {
      application: 'ramus-workflow-test',
      environment: 'test',
      chronicle,
    },
    async () => {
      return await runStep(
        {
          name: 'test-step',
          type: 'test-step',
        },
        async () => {
          const machine = new StateMachineRunner({
            config,
            input: 1,
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
        }
      );
    }
  );

  const outerStepId = (events[1] as StepStartEvent).step_id!;
  expect(outerStepId).toBeTruthy();

  console.log('outerStepId', outerStepId);

  const singleStepEvent = events[2] as StepStartEvent;
  expect(singleStepEvent.type).toEqual('step:start');
  expect(singleStepEvent.run_id).toEqual(runId);
  expect(singleStepEvent.data.parent_step).toEqual(outerStepId);

  expect(events[3].type).toEqual('step:end');

  const startEvent = events[4] as StepStartEvent;
  expect(startEvent.type).toEqual('step:start');
  expect(startEvent.run_id).toEqual(runId);
  expect(startEvent.data.parent_step).toEqual(outerStepId);

  const nodeStartEvents = events
    .slice(5)
    .filter((e) => e.type === 'step:start') as StepStartEvent[];
  expect(nodeStartEvents.length).toEqual(5);

  for (let event of nodeStartEvents) {
    expect(event.data.parent_step).toEqual(startEvent.step_id);
    expect(event.run_id).toEqual(runId);
  }
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

  const finished = machine.finished;

  await machine.run();
  // We should be stopped at the failed state.
  expect(machine.canStep()).toBe(true);
  expect(machine.state).toBe('two');
  expect(machine.machineStatus).toBe('error');

  expect(finished).rejects.toThrowError('error');
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

  const events: ChronicleEvent[] = [];
  const chronicle = createChronicleClient();
  chronicle.on('event', (e) => events.push(e));

  const machine = new StateMachineRunner({
    config,
    input: 1,
  });

  await startRun({ environment: 'test', chronicle }, async () => {
    await machine.run();
    expect(machine.canStep()).toBe(false);
    expect(machine.state).toBe('done');
    expect(machine.machineStatus).toBe('final');
    expect(machine.context.value).toBe(6);
  });

  // Make sure we saw an event for the reroute state even though it doesn't have a run function.
  const rerouteEvent = events.find(
    (e) => e.type === 'step:start' && (e as StepStartEvent).data?.name === 'test: reroute'
  );
  console.log(events);
  expect(rerouteEvent).toBeTruthy();
});

test('finished', async () => {});

describe('events', () => {
  test.todo('event needed from initial state');
  test.todo('events sent while running get queued up and handled later');
  test.todo('event causes a step');
  test.todo('event does not cause a step');
  test.todo('queued events');
});

describe('validation', () => {
  test.todo('simple transition references invalid state');
  test.todo('complex transition references invalid state');
  test.todo('initial state does not exist');
  test.todo('error state does not exist');
});
