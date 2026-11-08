import { describe, expect, test } from 'bun:test';
import { type Address, address } from '@solana/kit';
import { knownProgramSet } from '../../../src/solana/known-programs.ts';
import { selectExplorerLink } from '../../../src/solana/explorer.ts';
import { type InstructionRecord, PROGRAM_IDS } from '../../../src/solana/types.ts';

const known = knownProgramSet([]);
const UNKNOWN = address('AjTXzfxCuiDhuZhC6fdLmkS1fzmMbd1439ekrGqWVXLe');
const RECIPIENT = address('8FR6WzYbQ5ZMKZSWBNnQEMdpSLfXYevv425LkYLHPbq9');
const ix = (programAddress: string, i: number, inner = false): InstructionRecord => ({
  programAddress: programAddress as Address,
  topLevelIndex: i,
  inner,
  stackHeight: inner ? 2 : 1,
  parsed: { kind: 'other' },
});
const short = 'AQAB+/=';
const long = 'A'.repeat(600);

describe('selectExplorerLink', () => {
  test('inspector URL when ≤ 512 chars, message URL-encoded', () => {
    const r = selectExplorerLink({ cluster: 'devnet', messageBase64: short, topLevel: [], knownPrograms: known });
    expect(r).toEqual({
      url: `https://explorer.solana.com/tx/inspector?cluster=devnet&message=${encodeURIComponent(short)}`,
    });
    const m = selectExplorerLink({ cluster: 'mainnet', messageBase64: short, topLevel: [], knownPrograms: known });
    expect('url' in m && m.url.includes('cluster=mainnet-beta')).toBe(true);
  });

  test('exactly 512 chars still uses the inspector', () => {
    const prefix = 'https://explorer.solana.com/tx/inspector?cluster=devnet&message='.length;
    const msg = 'A'.repeat(512 - prefix);
    const r = selectExplorerLink({ cluster: 'devnet', messageBase64: msg, topLevel: [], knownPrograms: known });
    expect('url' in r && r.url.length).toBe(512);
    const over = selectExplorerLink({ cluster: 'devnet', messageBase64: `${msg}A`, topLevel: [], knownPrograms: known });
    expect(over).toEqual({ none: true });
  });

  test('too long → first non-known top-level program', () => {
    const r = selectExplorerLink({
      cluster: 'devnet',
      messageBase64: long,
      topLevel: [ix(PROGRAM_IDS.system, 0), ix(UNKNOWN, 1), ix(RECIPIENT, 2)],
      knownPrograms: known,
      firstTransferRecipient: RECIPIENT,
    });
    expect(r).toEqual({ url: `https://explorer.solana.com/address/${UNKNOWN}?cluster=devnet` });
  });

  test('too long, all known → first transfer recipient', () => {
    const r = selectExplorerLink({
      cluster: 'mainnet',
      messageBase64: long,
      topLevel: [ix(PROGRAM_IDS.system, 0)],
      knownPrograms: known,
      firstTransferRecipient: RECIPIENT,
    });
    expect(r).toEqual({ url: `https://explorer.solana.com/address/${RECIPIENT}?cluster=mainnet-beta` });
  });

  test('too long, nothing to link → none', () => {
    expect(
      selectExplorerLink({ cluster: 'devnet', messageBase64: long, topLevel: [ix(PROGRAM_IDS.splToken, 0)], knownPrograms: known }),
    ).toEqual({ none: true });
  });

  test('no message → fallback chain', () => {
    expect(selectExplorerLink({ cluster: 'devnet', topLevel: [ix(UNKNOWN, 0)], knownPrograms: known })).toEqual({
      url: `https://explorer.solana.com/address/${UNKNOWN}?cluster=devnet`,
    });
  });
});
