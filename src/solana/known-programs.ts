/**
 * Known_Program set (Req 8.6). Built-in programs are always known; operators
 * can add more through config.
 */
import type { Address } from '@solana/kit';
import { PROGRAM_IDS } from './types.ts';

export const BUILTIN_KNOWN_PROGRAMS: readonly Address[] = [
  PROGRAM_IDS.system,
  PROGRAM_IDS.computeBudget,
  PROGRAM_IDS.splToken,
  PROGRAM_IDS.token2022,
  PROGRAM_IDS.ata,
  PROGRAM_IDS.memoV1,
  PROGRAM_IDS.memoV2,
  PROGRAM_IDS.memoV3,
] as Address[];

/** Built-in programs merged with configured extras. */
export function knownProgramSet(extra: readonly Address[]): ReadonlySet<Address> {
  return new Set<Address>([...BUILTIN_KNOWN_PROGRAMS, ...extra]);
}

export function isKnownProgram(program: Address, known: ReadonlySet<Address>): boolean {
  return known.has(program);
}
