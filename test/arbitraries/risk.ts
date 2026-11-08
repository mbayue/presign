/** Builders for Risk_Engine tests. Addresses are opaque labels; rules never validate them. */
import type { Address } from '@solana/kit';
import type { RiskInput } from '../../src/risk/types.ts';
import { PROGRAM_IDS, type InstructionRecord, type ParsedInstruction } from '../../src/solana/types.ts';
import type { ScanResult } from '../../src/scan/types.ts';

export const addr = (s: string): Address => s as Address;

export const SUBJECT = addr('Subject111111111111111111111111111111111111');
export const OTHER = addr('Other1111111111111111111111111111111111111');
export const DELEGATE = addr('Delegate11111111111111111111111111111111111');
export const TOKEN_ACCOUNT = addr('TokenAcct1111111111111111111111111111111111');
export const MINT = addr('Mint111111111111111111111111111111111111111');
export const UNKNOWN_PROG = addr('Unknown1111111111111111111111111111111111111');

export const KNOWN: ReadonlySet<Address> = new Set(
  [PROGRAM_IDS.system, PROGRAM_IDS.splToken, PROGRAM_IDS.token2022, PROGRAM_IDS.ata, PROGRAM_IDS.computeBudget].map(addr),
);

const programFor = (p: ParsedInstruction): Address => {
  switch (p.kind) {
    case 'system-transfer':
    case 'system-transfer-with-seed':
      return addr(PROGRAM_IDS.system);
    case 'ata-create':
      return addr(PROGRAM_IDS.ata);
    case 'other':
    case 'unparseable':
      return UNKNOWN_PROG;
    default:
      return addr(p.program === 'token-2022' ? PROGRAM_IDS.token2022 : PROGRAM_IDS.splToken);
  }
};

export function ix(
  parsed: ParsedInstruction,
  opts: { index?: number; inner?: boolean; program?: Address } = {},
): InstructionRecord {
  const inner = opts.inner ?? false;
  return {
    programAddress: opts.program ?? programFor(parsed),
    topLevelIndex: opts.index ?? 0,
    inner,
    stackHeight: inner ? 2 : 1,
    parsed,
  };
}

export function riskInput(over: Partial<RiskInput> = {}): RiskInput {
  return {
    subject: SUBJECT,
    knownPrograms: KNOWN,
    topLevel: [],
    inner: [],
    simulation: { status: 'ok', balances: { sol: { pre: 10_000_000n, post: 10_000_000n }, tokens: [] } },
    preTokenAccounts: new Map(),
    mints: new Map(),
    context: { unresolvedAccounts: false, amountUnspecified: false, invalidResponses: [] },
    ...over,
  };
}

export function scanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    link: { raw: 'https://example.com/action', kind: 'blink', host: 'example.com' },
    cluster: 'devnet',
    clusterInfo: { source: 'default' },
    verdict: 'safe',
    flags: [],
    balanceChanges: [],
    transfers: [],
    simulation: { status: 'ok' },
    explorer: { url: 'https://explorer.solana.com/tx/inspector?cluster=devnet&message=abc' },
    timedOut: false,
    extensions: {},
    ...over,
  };
}
