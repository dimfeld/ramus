import { test, expect } from 'bun:test';
import { asStep, recordStepInfo, startRun } from './tracing';
import { WorkflowEvent } from './events';
import { uuidv7 } from 'uuidv7';

test('steps', async () => {
  const step1 = asStep(async function step1(number1: number, number2: number) {
    return await step2(number1 + number2);
  });

  const step2 = asStep(
    async (number: number) => {
      const v1 = await step3(1);
      const v2 = await step3(2);

      return number + v1 + v2;
    },
    {
      name: 'call_step_3',
      info: { style: 'slow' },
      tags: ['abc'],
    }
  );

  const step3 = asStep(
    async function step3(value: number) {
      await Bun.sleep(20);
      recordStepInfo({ reason: 'none' });
      return value;
    },
    {
      tags: ['sleepy'],
      info: {
        flavor: 'sweet',
      },
    }
  );

  const events: WorkflowEvent[] = [];

  let runId = uuidv7();
  let result = await startRun(
    {
      runId,
      logEvent: (e) => events.push(e),
    },
    async () => {
      return await step1(1, 2);
    }
  );

  expect(result).toBe(6);

  // step1
  expect(events[0]?.type).toEqual('step:start');
  expect(events[0].runId).toEqual(runId);
  expect(events[0].sourceNode).toEqual('step1');
  expect(events[0].data.input).toEqual([1, 2]);

  expect(events[1]?.type).toEqual('step:start');
  expect(events[1].runId).toEqual(runId);
  expect(events[1].sourceNode).toEqual('call_step_3');
  expect(events[1].data.tags).toEqual(['abc']);
  expect(events[1].data.input).toEqual(3);
  expect(events[1].data.info).toEqual({ style: 'slow' });
  expect(events[1].data.parent_step).toEqual(events[0].step);

  expect(events[2]?.type).toEqual('step:start');
  expect(events[2].runId).toEqual(runId);
  expect(events[2].sourceNode).toEqual('step3');
  expect(events[2].data.input).toEqual(1);
  expect(events[2].data.tags).toEqual(['sleepy']);
  expect(events[2].data.info).toEqual({ flavor: 'sweet' });
  expect(events[2].data.parent_step).toEqual(events[1].step);

  expect(events[3]?.type).toEqual('step:end');
  expect(events[3].runId).toEqual(runId);
  expect(events[3].step).toEqual(events[2].step);
  expect(events[3].data.info).toEqual({ reason: 'none' });
  expect(events[3].sourceNode).toEqual('step3');
  expect(events[3].data.output).toEqual(1);

  expect(events[4]?.type).toEqual('step:start');
  expect(events[4].runId).toEqual(runId);
  expect(events[4].sourceNode).toEqual('step3');
  expect(events[4].data.tags).toEqual(['sleepy']);
  expect(events[4].data.info).toEqual({ flavor: 'sweet' });
  expect(events[4].data.input).toEqual(2);
  expect(events[4].data.parent_step).toEqual(events[1].step);

  expect(events[5]?.type).toEqual('step:end');
  expect(events[5].runId).toEqual(runId);
  expect(events[5].step).toEqual(events[4].step);
  expect(events[5].data.info).toEqual({ reason: 'none' });
  expect(events[5].sourceNode).toEqual('step3');
  expect(events[5].data.output).toEqual(2);
});
