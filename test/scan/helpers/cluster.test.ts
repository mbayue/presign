import { describe, expect, test } from 'bun:test';
import { address } from '@solana/kit';
import { selectCluster } from '../../../src/scan/cluster.ts';
import type { ScannableLink } from '../../../src/scan/types.ts';

const blink = (raw: string, actionUrl: string, via: 'solana-action' | 'dial.to' | 'actions-json' | 'direct' = 'actions-json'): ScannableLink => ({
  kind: 'blink',
  raw,
  via,
  actionUrl,
});

describe('selectCluster', () => {
  test('override wins over every link parameter', () => {
    const link = blink('https://x.example/a?cluster=devnet', 'https://x.example/api/a?cluster=devnet');
    expect(selectCluster(link, 'devnet', 'mainnet')).toEqual({ cluster: 'mainnet', source: 'override' });
  });

  test('no link and no parameter → default', () => {
    expect(selectCluster(null, 'mainnet')).toEqual({ cluster: 'mainnet', source: 'default' });
    expect(selectCluster(blink('https://x.example/a', 'https://x.example/api/a'), 'devnet')).toEqual({
      cluster: 'devnet',
      source: 'default',
    });
  });

  test('outer parameter of an actions.json blink', () => {
    const link = blink('https://x.example/a?cluster=devnet', 'https://x.example/api/a');
    expect(selectCluster(link, 'mainnet')).toEqual({ cluster: 'devnet', source: 'outer' });
  });

  test('embedded parameter of the Action URL', () => {
    const link = blink('https://x.example/a', 'https://x.example/api/a?cluster=mainnet-beta');
    expect(selectCluster(link, 'devnet')).toEqual({ cluster: 'mainnet', source: 'embedded' });
  });

  test('conflict → outer wins', () => {
    const link = blink('https://x.example/a?cluster=mainnet-beta', 'https://x.example/api/a?cluster=devnet');
    expect(selectCluster(link, 'devnet')).toEqual({ cluster: 'mainnet', source: 'outer' });
  });

  test('values are case-insensitive', () => {
    const link = blink('https://x.example/a?cluster=DevNet', 'https://x.example/api/a');
    expect(selectCluster(link, 'mainnet').cluster).toBe('devnet');
    const link2 = blink('https://x.example/a?cluster=MAINNET-BETA', 'https://x.example/api/a');
    expect(selectCluster(link2, 'devnet').cluster).toBe('mainnet');
  });

  test('unsupported value is ignored and reported', () => {
    const link = blink('https://x.example/a?cluster=testnet', 'https://x.example/api/a');
    expect(selectCluster(link, 'mainnet')).toEqual({ cluster: 'mainnet', source: 'default', unsupportedValue: 'testnet' });
  });

  test('unsupported outer falls through to a recognized embedded value', () => {
    const link = blink('https://x.example/a?cluster=testnet', 'https://x.example/api/a?cluster=devnet');
    expect(selectCluster(link, 'mainnet')).toEqual({ cluster: 'devnet', source: 'embedded', unsupportedValue: 'testnet' });
  });

  test('literal solana-action: link → parameter is embedded', () => {
    const raw = 'solana-action:http://localhost:8787/api/actions/drainer?cluster=devnet';
    const link = blink(raw, 'http://localhost:8787/api/actions/drainer?cluster=devnet', 'solana-action');
    expect(selectCluster(link, 'mainnet')).toEqual({ cluster: 'devnet', source: 'embedded' });
  });

  test('percent-encoded solana-action: link with its own query → outer', () => {
    const raw = 'solana-action:https%3A%2F%2Fa.example%2Fapi%3Fcluster%3Ddevnet?cluster=mainnet-beta';
    const link = blink(raw, 'https://a.example/api?cluster=devnet', 'solana-action');
    expect(selectCluster(link, 'devnet')).toEqual({ cluster: 'mainnet', source: 'outer' });
  });

  test('dial.to outer parameter', () => {
    const raw = 'https://dial.to/?action=solana-action%3Ahttps%3A%2F%2Fa.example%2Fapi&cluster=devnet';
    const link = blink(raw, 'https://a.example/api', 'dial.to');
    expect(selectCluster(link, 'mainnet')).toEqual({ cluster: 'devnet', source: 'outer' });
  });

  test('transaction request: encoded link carries the embedded parameter', () => {
    const link: ScannableLink = {
      kind: 'transaction-request',
      raw: 'solana:https%3A%2F%2Fpay.example%2Fc%3Fcluster%3Ddevnet',
      request: { type: 'transaction', link: 'https://pay.example/c?cluster=devnet' },
    };
    expect(selectCluster(link, 'mainnet')).toEqual({ cluster: 'devnet', source: 'embedded' });
  });

  test('transfer request: parameter on the solana: URL is outer', () => {
    const link: ScannableLink = {
      kind: 'transfer-request',
      raw: 'solana:8FR6WzYbQ5ZMKZSWBNnQEMdpSLfXYevv425LkYLHPbq9?amount=1&cluster=devnet',
      request: { type: 'transfer', recipient: address('8FR6WzYbQ5ZMKZSWBNnQEMdpSLfXYevv425LkYLHPbq9'), references: [] },
    };
    expect(selectCluster(link, 'mainnet')).toEqual({ cluster: 'devnet', source: 'outer' });
  });
});
