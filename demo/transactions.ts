/**
 * Demo transactions (Req 16.2–16.5). Builders return UNSIGNED base64 v0 wire
 * transactions: the fee payer and owner are noop signers (no key), so every
 * signature slot is 64 zero bytes. No RPC and no keys are used.
 */
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getApproveInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

export const DEMO = {
  port: 8787,
  host: '127.0.0.1',
  /** Devnet USDC (SPL Token). */
  mint: address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  /**
   * PDAs of the System Program with seeds "demo-attacker" / "demo-recipient".
   * Off-curve, so no private key exists for either. Hard-coded so they never change.
   */
  attacker: address('AjTXzfxCuiDhuZhC6fdLmkS1fzmMbd1439ekrGqWVXLe'),
  safeRecipient: address('8FR6WzYbQ5ZMKZSWBNnQEMdpSLfXYevv425LkYLHPbq9'),
  approveAmount: 18_446_744_073_709_551_615n,
  safeLamports: 1_000_000n,
} as const;

/** Simulation uses `replaceRecentBlockhash: true`, so a dummy hash is enough. */
const DUMMY_LIFETIME = { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n };

function toUnsignedBase64(account: Address, instruction: Instruction): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(account), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(DUMMY_LIFETIME, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/** One SPL Token Approve: the account's devnet-USDC ATA delegates u64::MAX to the attacker. */
export async function drainerTransaction(account: Address): Promise<string> {
  const [source] = await findAssociatedTokenPda({ owner: account, mint: DEMO.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const approve = getApproveInstruction({
    source,
    delegate: DEMO.attacker,
    owner: createNoopSigner(account),
    amount: DEMO.approveAmount,
  });
  return toUnsignedBase64(account, approve);
}

/** One System transfer of 1,000,000 lamports to the safe recipient. */
export async function safeTransaction(account: Address): Promise<string> {
  const transfer = getTransferSolInstruction({
    source: createNoopSigner(account),
    destination: DEMO.safeRecipient,
    amount: DEMO.safeLamports,
  });
  return toUnsignedBase64(account, transfer);
}
