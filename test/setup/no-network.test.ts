import { expect, test } from 'bun:test';
import dns from 'node:dns';
import { takeNetworkAttempts } from './no-network.ts';
import { computeVerdict } from '../../src/risk/verdict.ts';
import { parseConfig, DEFAULT_PLACEHOLDER_ACCOUNT } from '../../src/config.ts';

test('blocked fetch records the URL even when the caller catches the error', async () => {
  await fetch('https://example.test/x').catch(() => undefined);
  expect(takeNetworkAttempts()).toEqual(['https://example.test/x']);
});

test('blocked DNS lookup records the hostname', async () => {
  await dns.promises.lookup('example.test').catch(() => undefined);
  expect(takeNetworkAttempts()).toEqual(['dns:example.test']);
});

test('computeVerdict ranks danger over caution over safe', () => {
  expect(computeVerdict([])).toBe('safe');
  expect(computeVerdict([{ severity: 'caution' }])).toBe('caution');
  expect(computeVerdict([{ severity: 'caution' }, { severity: 'danger' }])).toBe('danger');
});

test('parseConfig applies defaults and names invalid variables', () => {
  const ok = parseConfig({});
  expect('config' in ok ? String(ok.config.placeholderAccount) : null).toBe(DEFAULT_PLACEHOLDER_ACCOUNT);
  expect('config' in ok && ok.config.defaultCluster).toBe('mainnet');
  const bad = parseConfig({ SCAN_DEFAULT_CLUSTER: 'testnet', SOLANA_RPC_URL_DEVNET: 'ftp://x' });
  expect('errors' in bad && bad.errors.map((e) => e.variable).sort()).toEqual([
    'SCAN_DEFAULT_CLUSTER',
    'SOLANA_RPC_URL_DEVNET',
  ]);
});
