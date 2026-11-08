import type { Address } from '@solana/kit';
import type { AiContext } from '../../src/ai/prompt.ts';
import { untrusted } from '../../src/scan/types.ts';

export const RECIPIENT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' as Address;
export const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;

export function makeContext(overrides: Partial<AiContext> = {}): AiContext {
  return {
    verdict: 'danger',
    flags: [
      { ruleId: 'TOKEN_APPROVE', severity: 'danger', description: 'Grants a delegate control over your USDC.' },
      { ruleId: 'UNKNOWN_PROGRAM', severity: 'caution', description: 'Calls a program that is not on the known list.' },
    ],
    balanceChanges: [
      { asset: { kind: 'sol' }, rawDelta: -1_500_000_000n, decimals: 9, pre: 2_000_000_000n, post: 500_000_000n },
      { asset: { kind: 'token', mint: MINT }, rawDelta: 2_000_000n, decimals: 6, pre: 0n, post: 2_000_000n },
    ],
    transfers: [
      { asset: { kind: 'sol' }, instruction: 'system-transfer', recipient: RECIPIENT, raw: 1_500_000_000n, inner: false },
    ],
    instructionSummary: ['System: transfer', 'Token: approve'],
    cluster: 'mainnet',
    untrusted: [
      { label: 'title', value: untrusted('Free Airdrop') },
      { label: 'description', value: untrusted('Claim your reward now') },
    ],
    ...overrides,
  };
}
