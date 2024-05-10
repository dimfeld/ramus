import { expect, test } from 'bun:test';
import { Semaphore } from './semaphore.js';

test('run without wait', async () => {
  let semaphore = new Semaphore({ key: 1 });

  let ran = false;
  await semaphore.run('key', async () => {
    ran = true;
  });

  expect(ran).toBe(true);
});

test('run with wait', async () => {
  let semaphore = new Semaphore({ key: 1 });
  await semaphore.acquire('key');

  let ran = false;
  let task = semaphore.run('key', async () => {
    ran = true;
    return 1;
  });

  expect(ran).toBe(false);
  semaphore.release('key');

  expect(await task).toBe(1);
  expect(ran).toBe(true);
});

test('parallelism', async () => {
  let maxCounter = 0;
  let counter = 0;
  function inc() {
    maxCounter = Math.max(maxCounter, ++counter);
  }

  function dec() {
    counter--;
  }

  let semaphore = new Semaphore({ key: 50 });

  let promises = Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      semaphore.run('key', async () => {
        inc();
        let wait = Math.random() * 10;
        await new Promise((res) => setTimeout(res, wait));
        dec();
      })
    )
  );

  await promises;

  expect(maxCounter).toBe(50);
});

test('unknown key', async () => {
  let semaphore = new Semaphore({ key: 1 });

  await semaphore.acquire('otherKey');
  semaphore.release('otherKey');
});

test('extra release leaves count at 0', async () => {
  let semaphore = new Semaphore({ key: 1 });
  semaphore.release('key');
  expect(semaphore.counts.get('key')?.current).toBe(0);
});
