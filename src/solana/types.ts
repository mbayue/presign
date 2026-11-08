/**
 * Shared contracts for the Solana layer (decoder, parsers, simulator, builder,
 * enrichment, risk input). Implementations live in sibling modules; keep these
 * shapes stable so parallel modules agree.
 */
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import type { AuthorityTypeName, TokenProgram } from '../risk/flags.ts';
import type { Cluster, SimError, Untrusted } from '../scan/types.ts';

export type { AuthorityTypeName, TokenProgram };

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export type ScannerRpc = Rpc<SolanaRpcApi>;
export type ClusterRpcs = Record<Cluster, ScannerRpc>;

/** Program IDs used across modules. */
export const PROGRAM_IDS = {
  system: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  splToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  memoV1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  memoV2: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
} as const;

// ---------------------------------------------------------------------------
// Decoder output
// ---------------------------------------------------------------------------

export type AccountRef =
  | { kind: 'resolved'; address: Address; writable: boolean; signer: boolean }
  | { kind: 'unresolved'; table: Address; index: number; writable: boolean };

export type CompiledIx = { programAddress: Address; accounts: AccountRef[]; data: Uint8Array };

export interface DecodedTransaction {
  version: 'legacy' | 0 | 1;
  feePayer: Address;
  staticAccounts: Address[];
  lookups: { table: Address; writableIndexes: number[]; readonlyIndexes: number[] }[];
  /** Validator order: static, writable lookups, readonly lookups. */
  accountList: AccountRef[];
  /** Message order. */
  instructions: CompiledIx[];
  /** Base64 of the compiled message bytes (Explorer inspector). */
  messageBase64: string;
  /** Base64 of the full wire transaction (simulateTransaction). */
  wireBase64: string;
  unresolvedCount: number;
}

export type DecodeErrorCode = 'DECODE_FAILED' | 'TX_TOO_LARGE' | 'UNSUPPORTED_VERSION';
export type DecodeError = { code: DecodeErrorCode; detail: string; version?: 'legacy' | 'v0' | 'v1' };

// ---------------------------------------------------------------------------
// Parsed instructions
// ---------------------------------------------------------------------------

export type ParsedInstruction =
  | { kind: 'system-transfer'; source: Address; destination: Address; lamports: bigint }
  | { kind: 'system-transfer-with-seed'; source: Address; base: Address; destination: Address; lamports: bigint }
  | {
      kind: 'token-approve';
      program: TokenProgram;
      source: Address;
      delegate: Address;
      owner: Address;
      amount: bigint;
      mint?: Address;
      decimals?: number;
    }
  | {
      kind: 'token-set-authority';
      program: TokenProgram;
      target: Address;
      currentAuthority: Address;
      authorityType: AuthorityTypeName;
      newAuthority: Address | null;
    }
  | { kind: 'token-close'; program: TokenProgram; account: Address; destination: Address; authority: Address }
  | {
      kind: 'token-transfer';
      program: TokenProgram;
      source: Address;
      destination: Address;
      authority: Address;
      amount: bigint;
      mint?: Address;
      decimals?: number;
      variant: 'transfer' | 'checked' | 'checked-with-fee';
    }
  | { kind: 'token-mint-to'; program: TokenProgram; mint: Address; account: Address; amount: bigint }
  | { kind: 'token-burn'; program: TokenProgram; mint: Address; account: Address; amount: bigint }
  | { kind: 'ata-create'; wallet: Address; ata: Address; mint: Address; tokenProgram: Address }
  | { kind: 'other' }
  | { kind: 'unparseable'; reason: 'unresolved-account' | 'bad-data' };

export interface InstructionRecord {
  programAddress: Address;
  /** Own index for top-level; parent index for inner. */
  topLevelIndex: number;
  inner: boolean;
  /** 1 for top-level. */
  stackHeight: number;
  parsed: ParsedInstruction;
}

// ---------------------------------------------------------------------------
// Accounts, mints, simulation
// ---------------------------------------------------------------------------

export type AccountSnapshot =
  | { exists: false }
  | { exists: true; owner: Address; lamports: bigint; data: Uint8Array };

export type TokenAccountView = {
  address: Address;
  program: TokenProgram;
  mint: Address;
  owner: Address;
  amount: bigint;
};

export type MintView =
  | { status: 'ok'; address: Address; program: TokenProgram; decimals: number; permanentDelegate: Address | null }
  | { status: 'unreadable'; address: Address };

export type SimulationOutcome =
  | {
      status: 'ok';
      pre: Map<Address, AccountSnapshot>;
      post: Map<Address, AccountSnapshot>;
      inner: InstructionRecord[];
      logs: Untrusted[];
      unitsConsumed?: bigint;
    }
  | { status: 'failed'; pre: Map<Address, AccountSnapshot>; error: SimError; logs: Untrusted[] }
  | {
      status: 'unavailable';
      reason: 'timeout' | 'rpc-error' | 'rate-limited' | 'invalid-response';
      pre?: Map<Address, AccountSnapshot>;
    };
