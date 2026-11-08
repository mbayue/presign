/**
 * Deterministic risk rules (design "Risk rule table"). Every Flag comes from
 * `flagTemplates`; rules read only addresses, amounts, decimals, closed enums
 * and simulation balances from `RiskInput`, which carries no Untrusted text.
 *
 * The order of `RULES` is part of the determinism contract (Req 8.9).
 */
import type { Address } from '@solana/kit';
import { PROGRAM_IDS, type InstructionRecord, type ParsedInstruction } from '../solana/types.ts';
import type { TransferEntry } from '../scan/types.ts';
import { flagTemplates } from './flags.ts';
import { CannotEvaluate, type FlagSink, type RiskInput, type RiskRule } from './types.ts';

/** Rent-exempt minimum for a zero-data System account (Req 8.5). */
export const SOL_RENT_EXEMPT_MIN = 890_880n;

const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([PROGRAM_IDS.splToken, PROGRAM_IDS.token2022]);
const MINT_REFERENCING_PROGRAMS: ReadonlySet<string> = new Set([
  PROGRAM_IDS.splToken,
  PROGRAM_IDS.token2022,
  PROGRAM_IDS.ata,
]);

type Parsed<K extends ParsedInstruction['kind']> = Extract<ParsedInstruction, { kind: K }>;

/**
 * Records in scope: top-level always; inner only when simulation succeeded
 * (Req 7.10, 8.10). Order: each top-level record followed by its inner records,
 * then inner records whose parent is absent. Deterministic for a given input.
 */
export function recordsInScope(input: RiskInput): InstructionRecord[] {
  if (input.simulation.status !== 'ok' || input.inner.length === 0) return input.topLevel;
  const out: InstructionRecord[] = [];
  const used = new Set<InstructionRecord>();
  for (const top of input.topLevel) {
    out.push(top);
    for (const inner of input.inner) {
      if (inner.topLevelIndex === top.topLevelIndex && !used.has(inner)) {
        out.push(inner);
        used.add(inner);
      }
    }
  }
  for (const inner of input.inner) if (!used.has(inner)) out.push(inner);
  return out;
}

/** Throws CannotEvaluate when a record of one of `programs` has unresolved accounts. */
function requireResolved(records: readonly InstructionRecord[], programs: ReadonlySet<string>): void {
  for (const r of records) {
    if (r.parsed.kind === 'unparseable' && r.parsed.reason === 'unresolved-account' && programs.has(r.programAddress)) {
      throw new CannotEvaluate();
    }
  }
}

function tokenRecords(input: RiskInput): InstructionRecord[] {
  const records = recordsInScope(input);
  requireResolved(records, TOKEN_PROGRAMS);
  return records;
}

function* ofKind<K extends ParsedInstruction['kind']>(
  records: readonly InstructionRecord[],
  kind: K,
): Generator<{ record: InstructionRecord; ix: Parsed<K> }> {
  for (const record of records) {
    if (record.parsed.kind === kind) yield { record, ix: record.parsed as Parsed<K> };
  }
}

function mintDecimals(input: RiskInput, mint: Address | undefined): number | undefined {
  if (mint === undefined) return undefined;
  const view = input.mints.get(mint);
  return view?.status === 'ok' ? view.decimals : undefined;
}

/**
 * Mints referenced by token transfer / mint-to / burn / approve / ATA-create
 * records, then mints with a simulated balance (Req 8.4). Deduped, discovery order.
 */
export function referencedMints(input: RiskInput): Address[] {
  const records = recordsInScope(input);
  requireResolved(records, MINT_REFERENCING_PROGRAMS);
  const seen = new Set<Address>();
  const out: Address[] = [];
  const push = (m: Address | undefined) => {
    if (m !== undefined && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  };
  const accountMint = (a: Address) => input.preTokenAccounts.get(a)?.mint;
  for (const { parsed } of records) {
    switch (parsed.kind) {
      case 'token-transfer':
        push(parsed.mint ?? accountMint(parsed.source) ?? accountMint(parsed.destination));
        break;
      case 'token-approve':
        push(parsed.mint ?? accountMint(parsed.source));
        break;
      case 'token-mint-to':
      case 'token-burn':
      case 'ata-create':
        push(parsed.mint);
        break;
      default:
        break;
    }
  }
  if (input.simulation.status === 'ok') {
    for (const t of input.simulation.balances.tokens) push(t.mint);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const tokenApprove: RiskRule = {
  id: 'TOKEN_APPROVE',
  run(input, out) {
    for (const { ix } of ofKind(tokenRecords(input), 'token-approve')) {
      if (ix.owner !== input.subject) continue;
      const mint = ix.mint ?? input.preTokenAccounts.get(ix.source)?.mint;
      const decimals = mintDecimals(input, mint) ?? ix.decimals;
      const held = input.preTokenAccounts.get(ix.source);
      const atRisk = held !== undefined && held.amount > 0n ? { atRisk: { amount: held.amount, mint: held.mint } } : {};
      out.add(
        flagTemplates.TOKEN_APPROVE(
          decimals === undefined
            ? { delegate: ix.delegate, tokenAccount: ix.source, raw: ix.amount, ...atRisk }
            : { delegate: ix.delegate, tokenAccount: ix.source, raw: ix.amount, decimals, ...atRisk },
        ),
      );
    }
  },
};

const tokenSetAuthority: RiskRule = {
  id: 'TOKEN_SET_AUTHORITY',
  run(input, out) {
    for (const { ix } of ofKind(tokenRecords(input), 'token-set-authority')) {
      if (ix.currentAuthority !== input.subject) continue;
      out.add(
        flagTemplates.TOKEN_SET_AUTHORITY({
          authorityType: ix.authorityType,
          target: ix.target,
          newAuthority: ix.newAuthority,
        }),
      );
    }
  },
};

const tokenCloseToOther: RiskRule = {
  id: 'TOKEN_CLOSE_TO_OTHER',
  run(input, out) {
    for (const { ix } of ofKind(tokenRecords(input), 'token-close')) {
      if (ix.authority !== input.subject || ix.destination === input.subject) continue;
      out.add(flagTemplates.TOKEN_CLOSE_TO_OTHER({ account: ix.account, destination: ix.destination }));
    }
  },
};

const mintPermanentDelegate: RiskRule = {
  id: 'MINT_PERMANENT_DELEGATE',
  run(input, out) {
    for (const mint of referencedMints(input)) {
      const view = input.mints.get(mint);
      if (view?.status === 'ok' && view.program === 'token-2022' && view.permanentDelegate !== null) {
        out.add(flagTemplates.MINT_PERMANENT_DELEGATE({ mint, delegate: view.permanentDelegate }));
      }
    }
  },
};

const balanceDrained: RiskRule = {
  id: 'BALANCE_DRAINED',
  run(input, out) {
    if (input.simulation.status !== 'ok') return;
    const { sol, tokens } = input.simulation.balances;
    if (sol.pre >= SOL_RENT_EXEMPT_MIN && sol.post < SOL_RENT_EXEMPT_MIN) {
      out.add(flagTemplates.BALANCE_DRAINED({ asset: 'SOL', pre: sol.pre, post: sol.post, decimals: 9 }));
    }
    for (const t of tokens) {
      if (!(t.pre > 0n && t.post === 0n)) continue;
      const decimals = t.decimals ?? mintDecimals(input, t.mint);
      out.add(
        flagTemplates.BALANCE_DRAINED(
          decimals === undefined
            ? { asset: t.mint, pre: t.pre, post: t.post }
            : { asset: t.mint, pre: t.pre, post: t.post, decimals },
        ),
      );
    }
  },
};

const unknownProgram: RiskRule = {
  id: 'UNKNOWN_PROGRAM',
  run(input, out) {
    const seen = new Set<Address>();
    for (const { programAddress } of recordsInScope(input)) {
      if (input.knownPrograms.has(programAddress) || seen.has(programAddress)) continue;
      seen.add(programAddress);
      out.add(flagTemplates.UNKNOWN_PROGRAM({ program: programAddress }));
    }
  },
};

const simulationFailed: RiskRule = {
  id: 'SIMULATION_FAILED',
  run(input, out) {
    if (input.simulation.status !== 'failed') return;
    const { name, instructionIndex, customCode } = input.simulation.error;
    out.add(
      flagTemplates.SIMULATION_FAILED({
        name,
        ...(instructionIndex === undefined ? {} : { instructionIndex }),
        ...(customCode === undefined ? {} : { customCode }),
      }),
    );
  },
};

const simulationUnavailable: RiskRule = {
  id: 'SIMULATION_UNAVAILABLE',
  run(input, out) {
    if (input.simulation.status === 'unavailable') out.add(flagTemplates.SIMULATION_UNAVAILABLE());
  },
};

const permanentDelegateUnchecked: RiskRule = {
  id: 'PERMANENT_DELEGATE_UNCHECKED',
  run(input, out) {
    for (const mint of referencedMints(input)) {
      const view = input.mints.get(mint);
      if (view === undefined || view.status === 'unreadable') {
        out.add(flagTemplates.PERMANENT_DELEGATE_UNCHECKED({ mint }));
      }
    }
  },
};

const accountsUnresolved: RiskRule = {
  id: 'ACCOUNTS_UNRESOLVED',
  run(input, out) {
    if (input.context.unresolvedAccounts) out.add(flagTemplates.ACCOUNTS_UNRESOLVED());
  },
};

const amountUserChosen: RiskRule = {
  id: 'AMOUNT_USER_CHOSEN',
  run(input, out) {
    if (input.context.amountUnspecified) out.add(flagTemplates.AMOUNT_USER_CHOSEN());
  },
};

const invalidResponseRpc: RiskRule = {
  id: 'INVALID_RESPONSE_RPC',
  run(input, out) {
    if (input.context.invalidResponses.includes('rpc')) out.add(flagTemplates.INVALID_RESPONSE_RPC());
  },
};

const invalidResponseLinkServer: RiskRule = {
  id: 'INVALID_RESPONSE_LINK_SERVER',
  run(input, out) {
    if (input.context.invalidResponses.includes('link-server')) out.add(flagTemplates.INVALID_RESPONSE_LINK_SERVER());
  },
};

const TOKEN_TRANSFER_NAME = {
  transfer: 'token-transfer',
  checked: 'token-transfer-checked',
  'checked-with-fee': 'token-transfer-checked-with-fee',
} as const satisfies Record<Parsed<'token-transfer'>['variant'], TransferEntry['instruction']>;

/**
 * Records each System or token transfer authorized by the subject as a
 * TransferEntry, without a Flag (Req 8.8). Records with unresolved accounts
 * are skipped: the token rules and ACCOUNTS_UNRESOLVED already cover them.
 *
 * Uses the internal TRANSFER_RECORDING rule ID, so a failure is reported as
 * "Risk rule TRANSFER_RECORDING could not be evaluated."
 */
export const transferRecorder: RiskRule = {
  id: 'TRANSFER_RECORDING',
  run(input, out: FlagSink) {
    for (const record of recordsInScope(input)) {
      const p = record.parsed;
      const inner = record.inner;
      if (p.kind === 'system-transfer' && p.source === input.subject) {
        out.transfer({ asset: { kind: 'sol' }, instruction: 'system-transfer', recipient: p.destination, raw: p.lamports, decimals: 9, inner });
      } else if (p.kind === 'system-transfer-with-seed' && (p.source === input.subject || p.base === input.subject)) {
        out.transfer({
          asset: { kind: 'sol' },
          instruction: 'system-transfer-with-seed',
          recipient: p.destination,
          raw: p.lamports,
          decimals: 9,
          inner,
        });
      } else if (p.kind === 'token-transfer' && p.authority === input.subject) {
        const mint =
          p.mint ?? input.preTokenAccounts.get(p.source)?.mint ?? input.preTokenAccounts.get(p.destination)?.mint;
        if (mint === undefined) continue;
        const decimals = p.decimals ?? mintDecimals(input, mint);
        const recipientOwner = input.preTokenAccounts.get(p.destination)?.owner;
        out.transfer({
          asset: { kind: 'token', mint },
          instruction: TOKEN_TRANSFER_NAME[p.variant],
          recipient: p.destination,
          ...(recipientOwner === undefined ? {} : { recipientOwner }),
          raw: p.amount,
          ...(decimals === undefined ? {} : { decimals }),
          inner,
        });
      }
    }
  },
};

export const RULES: readonly RiskRule[] = [
  tokenApprove,
  tokenSetAuthority,
  tokenCloseToOther,
  mintPermanentDelegate,
  balanceDrained,
  unknownProgram,
  simulationFailed,
  simulationUnavailable,
  permanentDelegateUnchecked,
  accountsUnresolved,
  amountUserChosen,
  invalidResponseRpc,
  invalidResponseLinkServer,
  transferRecorder,
];
