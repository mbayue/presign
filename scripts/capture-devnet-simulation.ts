/**
 * One-off capture of a real devnet `simulateTransaction` response with inner
 * instructions (task 9.4). Run with `bun scripts/capture-devnet-simulation.ts`.
 *
 * This is the only file allowed to touch the network. It is never imported by
 * tests. It builds an UNSIGNED transaction: the fee payer is a funded devnet
 * validator identity read from `getVoteAccounts`, no key is loaded, and every
 * signature slot stays zero. Simulation runs with `sigVerify: false`.
 */
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const RPC_URL = 'https://api.devnet.solana.com';
const DEVNET_USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TRANSFER_LAMPORTS = 1_000_000n;
const MIN_PAYER_LAMPORTS = 10_000_000; // 0.01 SOL
const DUMMY_BLOCKHASH = blockhash('11111111111111111111111111111111');
const OUT_PATH = join(import.meta.dir, '..', 'test', 'fixtures', 'rpc', 'devnet-capture-ata-create.json');

type JsonRpcResponse = { jsonrpc: string; id: number; result?: unknown; error?: { code: number; message: string } };

let nextId = 1;

async function rpc(method: string, params: unknown[]): Promise<JsonRpcResponse> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (res.status === 429 || res.status >= 500) {
      console.warn(`${method}: HTTP ${res.status}, retry ${attempt}/5`);
      await Bun.sleep(2_000 * attempt);
      continue;
    }
    const body = (await res.json()) as JsonRpcResponse;
    if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
    return body;
  }
  throw new Error(`${method}: rate-limited after 5 attempts`);
}

/**
 * Fee payer = a funded validator identity whose devnet-USDC ATA does not exist
 * yet (CreateIdempotent on an existing ATA makes no CPI, so no inner
 * instructions). Recipient = another validator identity (a plain system account).
 */
async function pickAccounts(): Promise<{ payer: Address; recipient: Address; ata: Address }> {
  const votes = await rpc('getVoteAccounts', [{ commitment: 'confirmed' }]);
  const current = (votes.result as { current: { nodePubkey: string; activatedStake: number }[] }).current;
  const candidates = [...current].sort((a, b) => b.activatedStake - a.activatedStake).slice(0, 25);
  for (const c of candidates) {
    const bal = await rpc('getBalance', [c.nodePubkey, { commitment: 'confirmed' }]);
    const lamports = (bal.result as { value: number }).value;
    if (lamports <= MIN_PAYER_LAMPORTS) continue;
    const payer = address(c.nodePubkey);
    const [ata] = await findAssociatedTokenPda({ owner: payer, mint: DEVNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const info = await rpc('getAccountInfo', [ata, { encoding: 'base64', commitment: 'confirmed' }]);
    if ((info.result as { value: unknown }).value !== null) {
      console.log(`skip ${c.nodePubkey}: ATA ${ata} already exists`);
      continue;
    }
    console.log(`fee payer ${c.nodePubkey} balance ${lamports} lamports, ATA ${ata} absent`);
    const other = candidates.find((o) => o.nodePubkey !== c.nodePubkey);
    if (!other) throw new Error('need a second validator identity as recipient');
    return { payer, recipient: address(other.nodePubkey), ata };
  }
  throw new Error('no funded validator identity without an existing ATA found');
}

async function main(): Promise<void> {
  const { payer, recipient, ata } = await pickAccounts();
  const noop = createNoopSigner(payer);

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getTransferSolInstruction({ source: noop, destination: recipient, amount: TRANSFER_LAMPORTS }),
          getCreateAssociatedTokenIdempotentInstruction({
            payer: noop,
            ata,
            owner: payer,
            mint: DEVNET_USDC_MINT,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          }),
        ],
        m,
      ),
  );
  const transactionBase64 = getBase64EncodedWireTransaction(compileTransaction(message));

  const response = await rpc('simulateTransaction', [
    transactionBase64,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      innerInstructions: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [payer, ata] },
    },
  ]);

  const value = (response.result as { value?: { err: unknown; innerInstructions?: unknown } }).value;
  console.log('err:', JSON.stringify(value?.err ?? null));
  console.log('innerInstructions:', JSON.stringify(value?.innerInstructions ?? null).slice(0, 400));

  const fixture = {
    capturedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    addresses: {
      payer,
      recipient,
      mint: DEVNET_USDC_MINT,
      ata,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    transferLamports: TRANSFER_LAMPORTS.toString(),
    transactionBase64,
    response,
  };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${OUT_PATH}`);
}

await main();
