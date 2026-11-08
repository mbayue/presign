/**
 * Transfer_Builder (Req 4). Builds the unsigned v0 transaction a wallet would
 * build for a Solana Pay Transfer_Request. Nothing is signed: the fee payer and
 * authority are noop signers (no key), and compileTransaction leaves signature
 * slots empty, which the wire encoder writes as 64 zero bytes each.
 */
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token';
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionEncoder,
  type Instruction,
  LEGACY_TRANSACTION_SIZE_LIMIT,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { toBaseUnits, U64_MAX } from '../links/decimal.ts';
import type { FlagRequest, TransferBuildReason } from '../risk/flags.ts';
import { type Cluster, realSleep, type Sleep, type TransferRequest } from '../scan/types.ts';
import { AccountInfoResultSchema } from './schemas.ts';
import { type ClusterRpcs, PROGRAM_IDS, type ScannerRpc } from './types.ts';

export const MINT_READ_TIMEOUT_MS = 10_000;
/** Simulation runs with `replaceRecentBlockhash: true`, so any valid hash works. */
const DUMMY_LIFETIME = { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n };
const SOL_DECIMALS = 9;
/** Mint layout: `decimals` is the u8 at offset 44 of the 82-byte base mint. */
const MINT_DECIMALS_OFFSET = 44;
const MINT_BASE_SIZE = 82;

export type TransferBuildResult =
  | { ok: true; base64: string; amountUnspecified: boolean }
  | { ok: false; flag: FlagRequest };

const buildFailed = (reason: TransferBuildReason, mint?: Address): { ok: false; flag: FlagRequest } => ({
  ok: false,
  flag: mint === undefined ? { ruleId: 'TRANSFER_BUILD_FAILED', reason } : { ruleId: 'TRANSFER_BUILD_FAILED', reason, mint },
});

type MintRead =
  | { ok: true; program: Address; decimals: number }
  | { ok: false; reason: 'mint-missing' | 'mint-wrong-owner' | 'mint-read-failed' };

async function readMint(rpc: ScannerRpc, mint: Address, sleep: Sleep): Promise<MintRead> {
  const request = new AbortController();
  const timer = new AbortController();
  const TIMEOUT = Symbol('timeout');
  const timeout = sleep(MINT_READ_TIMEOUT_MS, timer.signal).then(
    () => {
      request.abort();
      return TIMEOUT;
    },
    () => new Promise<never>(() => {}),
  );
  let raw: unknown;
  try {
    raw = await Promise.race([
      rpc.getAccountInfo(mint, { encoding: 'base64' }).send({ abortSignal: request.signal }),
      timeout,
    ]);
  } catch {
    return { ok: false, reason: 'mint-read-failed' };
  } finally {
    timer.abort();
  }
  if (raw === TIMEOUT) return { ok: false, reason: 'mint-read-failed' };
  const parsed = AccountInfoResultSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'mint-read-failed' };
  const account = parsed.data.value;
  if (account === null) return { ok: false, reason: 'mint-missing' };
  if (account.owner !== PROGRAM_IDS.splToken && account.owner !== PROGRAM_IDS.token2022) {
    return { ok: false, reason: 'mint-wrong-owner' };
  }
  let data: Uint8Array;
  try {
    data = new Uint8Array(getBase64Encoder().encode(account.data[0]));
  } catch {
    return { ok: false, reason: 'mint-read-failed' };
  }
  const decimals = data[MINT_DECIMALS_OFFSET];
  if (data.length < MINT_BASE_SIZE || decimals === undefined) return { ok: false, reason: 'mint-read-failed' };
  return { ok: true, program: account.owner, decimals };
}

/** Reference keys go after the required accounts as read-only non-signers, in URL order (Req 4.3). */
function withReferences<T extends Instruction>(ix: T, references: Address[]): Instruction {
  return {
    ...ix,
    accounts: [...(ix.accounts ?? []), ...references.map((address) => ({ address, role: AccountRole.READONLY }))],
  };
}

export async function buildTransferTransaction(
  req: TransferRequest,
  subject: Address,
  cluster: Cluster,
  deps: { rpcs: ClusterRpcs; sleep?: Sleep },
): Promise<TransferBuildResult> {
  const payer = createNoopSigner(subject);
  const amountUnspecified = req.amount === undefined;
  // @solana-program/memo 0.16 defaults to a newer program (Memo4c2p...); Solana Pay wallets use
  // SPL Memo v2 (MemoSq4g..., the package's LEGACY_MEMO_PROGRAM_ADDRESS_V3), so pin it.
  const memo =
    req.memo === undefined
      ? []
      : [getAddMemoInstruction({ memo: req.memo }, { programAddress: PROGRAM_IDS.memoV2 as Address })];

  let transfer: Instruction;
  if (req.splToken === undefined) {
    const lamports = req.amount === undefined ? 0n : toBaseUnits(req.amount, SOL_DECIMALS);
    // The link parser rejects SOL amounts with more than 9 decimals; treat a stray one as out of range.
    if (lamports === null || lamports > U64_MAX) return buildFailed('amount-overflow');
    transfer = getTransferSolInstruction({ source: payer, destination: req.recipient, amount: lamports });
  } else {
    const mint = req.splToken;
    const read = await readMint(deps.rpcs[cluster], mint, deps.sleep ?? realSleep);
    if (!read.ok) return buildFailed(read.reason, mint);
    const raw = req.amount === undefined ? 0n : toBaseUnits(req.amount, read.decimals);
    if (raw === null) return buildFailed('amount-too-precise', mint);
    if (raw > U64_MAX) return buildFailed('amount-overflow', mint);
    const [source] = await findAssociatedTokenPda({ owner: subject, mint, tokenProgram: read.program });
    const [destination] = await findAssociatedTokenPda({ owner: req.recipient, mint, tokenProgram: read.program });
    transfer = getTransferCheckedInstruction(
      { source, mint, destination, authority: payer, amount: raw, decimals: read.decimals },
      { programAddress: read.program },
    );
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(DUMMY_LIFETIME, m),
    (m) => appendTransactionMessageInstructions([...memo, withReferences(transfer, req.references)], m),
  );
  const tx = compileTransaction(message);
  if (getTransactionEncoder().getSizeFromValue(tx) > LEGACY_TRANSACTION_SIZE_LIMIT) {
    return buildFailed('transaction-too-large', req.splToken);
  }
  return { ok: true, base64: getBase64EncodedWireTransaction(tx), amountUnspecified };
}
