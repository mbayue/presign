import type { Clock, Sleep } from '../../src/scan/types.ts';

/**
 * Controllable clock. `sleep` resolves when `advance` moves time past its
 * deadline, so timeout logic can be tested without real waiting.
 */
export function createFakeClock(start = 0): {
  clock: Clock;
  sleep: Sleep;
  advance(ms: number): Promise<void>;
  sleeps: number[];
} {
  let now = start;
  const sleeps: number[] = [];
  const waiters: { at: number; resolve: () => void; reject: (e: unknown) => void }[] = [];

  const sleep: Sleep = (ms, signal) => {
    sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const waiter = { at: now + ms, resolve, reject };
      waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
  };

  const advance = async (ms: number) => {
    now += ms;
    waiters.sort((a, b) => a.at - b.at);
    while (waiters.length > 0 && waiters[0]!.at <= now) {
      waiters.shift()!.resolve();
      // Let continuations run before releasing the next waiter.
      await Promise.resolve();
    }
    await Promise.resolve();
  };

  return { clock: { now: () => now }, sleep, advance, sleeps };
}
