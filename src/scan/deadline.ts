/**
 * Deadline helpers for the message handler (Req 11.9). `deadlineAt` is an
 * absolute time on `clock`. Work that finishes after the deadline is ignored;
 * these helpers do not cancel it.
 */
import { type Clock, realSleep, type Sleep } from './types.ts';

export type DeadlineOutcome<T> = { done: true; value: T } | { done: false };

export type RaceOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timedOut' };

/** Resolves when `sleep` finishes; never settles when the timer is cancelled. */
function timer(ms: number, sleep: Sleep, signal: AbortSignal): Promise<void> {
  return sleep(ms, signal).then(
    () => undefined,
    () => new Promise<never>(() => {}),
  );
}

/**
 * Waits for `promise` until `deadlineAt`. A rejection before the deadline is
 * rethrown; a rejection after it is swallowed.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  clock: Clock,
  sleep: Sleep = realSleep,
): Promise<DeadlineOutcome<T>> {
  // Keep a late rejection from surfacing as unhandled.
  promise.catch(() => {});
  const remaining = deadlineAt - clock.now();
  if (remaining <= 0) return { done: false };
  const cancel = new AbortController();
  try {
    return await Promise.race<DeadlineOutcome<T>>([
      promise.then((value) => ({ done: true, value })),
      timer(remaining, sleep, cancel.signal).then(() => ({ done: false })),
    ]);
  } finally {
    cancel.abort();
  }
}

/**
 * Settles each promise that finishes before `deadlineAt`; the rest are
 * reported as `timedOut`. Returns as soon as every promise has settled or the
 * deadline passes, in input order.
 */
export function raceAll<T>(
  promises: readonly Promise<T>[],
  deadlineAt: number,
  clock: Clock,
  sleep: Sleep = realSleep,
): Promise<RaceOutcome<T>[]> {
  const outcomes: RaceOutcome<T>[] = promises.map(() => ({ status: 'timedOut' }));
  if (promises.length === 0) return Promise.resolve([]);
  for (const p of promises) p.catch(() => {});

  const remaining = deadlineAt - clock.now();
  if (remaining <= 0) return Promise.resolve(outcomes);

  return new Promise<RaceOutcome<T>[]>((resolve) => {
    const cancel = new AbortController();
    let finished = false;
    let pending = promises.length;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancel.abort();
      // Copy so late completions cannot change what the caller received.
      resolve(outcomes.map((o) => ({ ...o })));
    };
    promises.forEach((p, i) => {
      p.then(
        (value) => {
          if (finished) return;
          outcomes[i] = { status: 'fulfilled', value };
          if (--pending === 0) finish();
        },
        (reason: unknown) => {
          if (finished) return;
          outcomes[i] = { status: 'rejected', reason };
          if (--pending === 0) finish();
        },
      );
    });
    void timer(remaining, sleep, cancel.signal).then(finish);
  });
}
