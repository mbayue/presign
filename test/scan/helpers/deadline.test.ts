import { describe, expect, test } from 'bun:test';
import { raceAll, withDeadline } from '../../../src/scan/deadline.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('withDeadline', () => {
  test('returns the value when the promise settles first', async () => {
    const fake = createFakeClock(0);
    const d = deferred<number>();
    const out = withDeadline(d.promise, 1_000, fake.clock, fake.sleep);
    d.resolve(7);
    expect(await out).toEqual({ done: true, value: 7 });
    expect(fake.sleeps).toEqual([1_000]);
  });

  test('times out when the deadline passes first; late value is ignored', async () => {
    const fake = createFakeClock(500);
    const d = deferred<number>();
    const out = withDeadline(d.promise, 1_500, fake.clock, fake.sleep);
    await flush();
    await fake.advance(1_000);
    expect(await out).toEqual({ done: false });
    d.resolve(1);
    d.promise.then(() => {});
  });

  test('rethrows a rejection before the deadline', async () => {
    const fake = createFakeClock(0);
    const d = deferred<number>();
    const out = withDeadline(d.promise, 1_000, fake.clock, fake.sleep);
    d.reject(new Error('boom'));
    await expect(out).rejects.toThrow('boom');
  });

  test('deadline already passed → not done', async () => {
    const fake = createFakeClock(2_000);
    expect(await withDeadline(new Promise<number>(() => {}), 1_000, fake.clock, fake.sleep)).toEqual({ done: false });
  });
});

describe('raceAll', () => {
  test('returns once every promise settled, in input order', async () => {
    const fake = createFakeClock(0);
    const a = deferred<string>();
    const b = deferred<string>();
    const out = raceAll([a.promise, b.promise], 20_000, fake.clock, fake.sleep);
    b.resolve('b');
    a.reject(new Error('a failed'));
    const r = await out;
    expect(r[0]).toMatchObject({ status: 'rejected' });
    expect(r[1]).toEqual({ status: 'fulfilled', value: 'b' });
  });

  test('marks unfinished promises timed out and ignores late completions', async () => {
    const fake = createFakeClock(0);
    const fast = deferred<string>();
    const slow = deferred<string>();
    const out = raceAll([fast.promise, slow.promise], 20_000, fake.clock, fake.sleep);
    fast.resolve('fast');
    await flush();
    await fake.advance(20_000);
    const r = await out;
    expect(r).toEqual([{ status: 'fulfilled', value: 'fast' }, { status: 'timedOut' }]);
    slow.resolve('late');
    await flush();
    expect(r[1]).toEqual({ status: 'timedOut' });
  });

  test('empty input and past deadline', async () => {
    const fake = createFakeClock(5);
    expect(await raceAll([], 0, fake.clock, fake.sleep)).toEqual([]);
    expect(await raceAll([new Promise<number>(() => {})], 0, fake.clock, fake.sleep)).toEqual([{ status: 'timedOut' }]);
  });
});
