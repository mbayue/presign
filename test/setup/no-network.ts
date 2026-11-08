/**
 * Preloaded by bunfig.toml. Any real network access during `bun test` fails
 * the current test, even if production code caught the error (Req 19.1, 19.10).
 * Tests must pass fakes through `deps` parameters instead.
 */
import { afterEach } from 'bun:test';
import dns from 'node:dns';

export class NetworkAccessError extends Error {
  constructor(target: string) {
    super(`Network access attempted: ${target}`);
    this.name = 'NetworkAccessError';
  }
}

const attempts: string[] = [];

const describeTarget = (input: unknown): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
};

const blockedFetch = ((input: unknown) => {
  const target = describeTarget(input);
  attempts.push(target);
  return Promise.reject(new NetworkAccessError(target));
}) as unknown as typeof fetch;

globalThis.fetch = blockedFetch;

const blockedLookup = ((hostname: string) => {
  attempts.push(`dns:${hostname}`);
  return Promise.reject(new NetworkAccessError(`dns:${hostname}`));
}) as unknown as typeof dns.promises.lookup;

dns.promises.lookup = blockedLookup;

/** For the guard's own test: read and clear recorded attempts. */
export const takeNetworkAttempts = (): string[] => attempts.splice(0, attempts.length);

afterEach(() => {
  if (attempts.length > 0) {
    const recorded = takeNetworkAttempts();
    throw new Error(`Network access attempted: ${recorded.join(', ')}`);
  }
});
