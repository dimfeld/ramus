export interface Semaphore {
  acquire(key: string): Promise<void>;
  release(key: string): void | Promise<void>;
  run<T>(key: string, f: () => Promise<T>): Promise<T>;
}

interface SemaphoreClass {
  limit: number;
  current: number;
  pending: Array<() => void>;
}

export class LocalSemaphore implements Semaphore {
  counts = new Map<string, SemaphoreClass>();

  constructor(limits: Record<string, number>) {
    Object.entries(limits).forEach(([key, limit]) => {
      this.counts.set(key, { limit, current: 0, pending: [] });
    });
  }

  /** Update the limit for a semaphore key. */
  setLimit(key: string, limit: number) {
    let value = this.counts.get(key);
    if (value) {
      value.limit = limit;

      // If the limit went up, run some pending tasks.
      while (value.pending.length > 0 && value.current < value.limit) {
        let resolve = value.pending.shift();
        resolve?.();
        value.current++;
      }
    } else {
      this.counts.set(key, { limit, current: 0, pending: [] });
    }
  }

  /** Acquire a slot in the semaphore. Returns a promise that resolves when the slot is available.
   * These slots will not automatically release; you must call `release` with the same key when done, even if your
   * code throws an error.
   *
   * You can use the `run` function instead to automatically manage the acquisition and release of the semaphore. */
  async acquire(key: string) {
    let value = this.counts.get(key);
    if (!value) {
      // If there's no data for this key, then there's no limit, so no point in tracking anything.
      // This can legitimately happen when there are multiple semaphores in use for a node and only some of them
      // are rate limiting its key.
      return Promise.resolve();
    }

    if (value.current >= value.limit) {
      // We're at the limit already, so wait for a release
      return new Promise<void>((resolve) => {
        value.pending.push(resolve);
      });
    } else {
      // We're not at the limit, so increment the count and resolve the promise immediately.
      value.current += 1;
      return Promise.resolve();
    }
  }

  release(key: string) {
    let value = this.counts.get(key);
    if (value) {
      if (value.pending.length > 0 && value.current === value.limit) {
        let resolve = value.pending.shift();
        resolve?.();
      } else {
        value.current = Math.max(value.current - 1, 0);
      }
    }
  }

  /** Run a function as soon as the semaphore key's limit allows it */
  async run<T>(key: string, f: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      let value = await f();
      return value;
    } finally {
      this.release(key);
    }
  }
}

/** Acquire multiple semaphores concurrently. */
export async function acquireSemaphores(semaphores: Semaphore[], key: string) {
  let acquired: boolean[] = [];
  let error = false;
  try {
    await Promise.all(
      semaphores.map(async (s, i) => {
        await s.acquire(key);
        if (error) {
          // An error occurred somewhere else so immeidately release this semaphore.
          await s.release(key);
        } else {
          acquired[i] = true;
        }
      })
    );
  } catch (e) {
    // Release the already-acquired semaphores, and flag the error so that any which finish
    // acquiring after this can release on their own.
    error = true;
    for (let i = 0; i < semaphores.length; i++) {
      if (acquired[i]) {
        semaphores[i].release(key);
      }
    }

    throw e;
  }

  return () => Promise.all(semaphores.map((s) => s.release(key))).then(() => {});
}
