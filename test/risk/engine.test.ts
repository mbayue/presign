import { describe, expect, test } from 'bun:test';
import { U64_MAX } from '../../src/links/decimal.ts';
import { evaluate } from '../../src/risk/engine.ts';
import { RULES } from '../../src/risk/rules.ts';
import { CannotEvaluate, type RiskRule } from '../../src/risk/types.ts';
import { PROGRAM_IDS } from '../../src/solana/types.ts';
import {
  addr,
  DELEGATE,
  ix,
  MINT,
  OTHER,
  riskInput,
  SUBJECT,
  TOKEN_ACCOUNT,
  UNKNOWN_PROG,
} from '../arbitraries/risk.ts';

const approve = (owner = SUBJECT, amount = U64_MAX) =>
  ix({ kind: 'token-approve', program: 'spl-token', source: TOKEN_ACCOUNT, delegate: DELEGATE, owner, amount });

const ids = (input: Parameters<typeof evaluate>[0]) => evaluate(input).flags.map((f) => f.ruleId);

describe('TOKEN_APPROVE', () => {
  test('approve owned by subject → danger with UNLIMITED for u64 max', () => {
    const out = evaluate(riskInput({ topLevel: [approve()] }));
    expect(out.flags).toHaveLength(1);
    expect(out.flags[0]!.ruleId).toBe('TOKEN_APPROVE');
    expect(out.flags[0]!.severity).toBe('danger');
    expect(out.flags[0]!.description).toContain('UNLIMITED');
    expect(out.flags[0]!.description).toContain(DELEGATE);
    expect(out.verdict).toBe('danger');
  });

  test('decimals come from the mint map', () => {
    const mints = new Map([[MINT, { status: 'ok' as const, address: MINT, program: 'spl-token' as const, decimals: 6, permanentDelegate: null }]]);
    const rec = ix({ kind: 'token-approve', program: 'spl-token', source: TOKEN_ACCOUNT, delegate: DELEGATE, owner: SUBJECT, amount: 1_500_000n, mint: MINT });
    const [flag] = evaluate(riskInput({ topLevel: [rec], mints })).flags;
    expect(flag!.description).toContain('1500000 base units (1.5)');
  });

  test('approve owned by someone else → no flag', () => {
    expect(evaluate(riskInput({ topLevel: [approve(OTHER)] })).flags).toEqual([]);
  });

  test('inner approve ignored when simulation failed', () => {
    const out = evaluate(
      riskInput({
        inner: [{ ...approve(), inner: true, stackHeight: 2 }],
        simulation: { status: 'failed', error: { name: 'Custom', programNotFound: false } },
      }),
    );
    expect(out.flags.map((f) => f.ruleId)).toEqual(['SIMULATION_FAILED']);
  });

  test('inner approve counted when simulation ok', () => {
    expect(ids(riskInput({ inner: [{ ...approve(), inner: true, stackHeight: 2 }] }))).toEqual(['TOKEN_APPROVE']);
  });

  test('unresolved token instruction → RULE_UNEVALUATED for the token rules, never safe', () => {
    const rec = ix({ kind: 'unparseable', reason: 'unresolved-account' }, { program: addr(PROGRAM_IDS.splToken) });
    const out = evaluate(riskInput({ topLevel: [rec] }));
    const unevaluated = out.flags.filter((f) => f.ruleId === 'RULE_UNEVALUATED').map((f) => f.description);
    expect(unevaluated).toContain('Risk rule TOKEN_APPROVE could not be evaluated.');
    expect(unevaluated).toContain('Risk rule MINT_PERMANENT_DELEGATE could not be evaluated.');
    expect(out.verdict).toBe('caution');
  });
});

describe('TOKEN_SET_AUTHORITY / TOKEN_CLOSE_TO_OTHER', () => {
  test('set-authority to null says "Removes"', () => {
    const rec = ix({
      kind: 'token-set-authority',
      program: 'token-2022',
      target: TOKEN_ACCOUNT,
      currentAuthority: SUBJECT,
      authorityType: 'account owner',
      newAuthority: null,
    });
    const [flag] = evaluate(riskInput({ topLevel: [rec] })).flags;
    expect(flag!.ruleId).toBe('TOKEN_SET_AUTHORITY');
    expect(flag!.severity).toBe('danger');
    expect(flag!.description.startsWith('Removes')).toBe(true);
  });

  test('close to other → danger; close to subject → none', () => {
    const close = (destination = OTHER) =>
      ix({ kind: 'token-close', program: 'spl-token', account: TOKEN_ACCOUNT, destination, authority: SUBJECT });
    expect(ids(riskInput({ topLevel: [close()] }))).toEqual(['TOKEN_CLOSE_TO_OTHER']);
    expect(evaluate(riskInput({ topLevel: [close()] })).verdict).toBe('danger');
    expect(ids(riskInput({ topLevel: [close(SUBJECT)] }))).toEqual([]);
  });
});

describe('MINT_PERMANENT_DELEGATE / PERMANENT_DELEGATE_UNCHECKED', () => {
  const create = ix({ kind: 'ata-create', wallet: SUBJECT, ata: TOKEN_ACCOUNT, mint: MINT, tokenProgram: addr(PROGRAM_IDS.token2022) });

  test('token-2022 mint with permanent delegate → one danger flag', () => {
    const mints = new Map([[MINT, { status: 'ok' as const, address: MINT, program: 'token-2022' as const, decimals: 6, permanentDelegate: DELEGATE }]]);
    const balances = { sol: { pre: 1n, post: 1n }, tokens: [{ mint: MINT, pre: 5n, post: 5n }] };
    const out = evaluate(riskInput({ topLevel: [create], mints, simulation: { status: 'ok', balances } }));
    expect(out.flags.map((f) => f.ruleId)).toEqual(['MINT_PERMANENT_DELEGATE']);
  });

  test('missing or unreadable mint → caution unchecked', () => {
    expect(ids(riskInput({ topLevel: [create] }))).toEqual(['PERMANENT_DELEGATE_UNCHECKED']);
    const mints = new Map([[MINT, { status: 'unreadable' as const, address: MINT }]]);
    expect(ids(riskInput({ topLevel: [create], mints }))).toEqual(['PERMANENT_DELEGATE_UNCHECKED']);
  });
});

describe('BALANCE_DRAINED', () => {
  test('SOL and token drained → two danger flags', () => {
    const balances = { sol: { pre: 1_000_000n, post: 5_000n }, tokens: [{ mint: MINT, pre: 42n, post: 0n, decimals: 0 }] };
    const mints = new Map([[MINT, { status: 'ok' as const, address: MINT, program: 'spl-token' as const, decimals: 0, permanentDelegate: null }]]);
    const out = evaluate(riskInput({ simulation: { status: 'ok', balances }, mints }));
    expect(out.flags.map((f) => [f.ruleId, f.severity])).toEqual([
      ['BALANCE_DRAINED', 'danger'],
      ['BALANCE_DRAINED', 'danger'],
    ]);
    expect(out.flags[0]!.description).toContain('SOL');
    expect(out.flags[1]!.description).toContain(MINT);
  });

  test('SOL staying at rent-exempt minimum is not drained', () => {
    const balances = { sol: { pre: 1_000_000n, post: 890_880n }, tokens: [] };
    expect(ids(riskInput({ simulation: { status: 'ok', balances } }))).toEqual([]);
  });
});

describe('UNKNOWN_PROGRAM and simulation status', () => {
  test('unknown program twice → one caution', () => {
    const out = evaluate(riskInput({ topLevel: [ix({ kind: 'other' }, { index: 0 }), ix({ kind: 'other' }, { index: 1 })] }));
    expect(out.flags).toEqual([{ ruleId: 'UNKNOWN_PROGRAM', severity: 'caution', description: `Calls unverified program ${UNKNOWN_PROG}.` }]);
    expect(out.verdict).toBe('caution');
  });

  test('simulation failed passes index and custom code', () => {
    const out = evaluate(
      riskInput({ simulation: { status: 'failed', error: { name: 'Custom', instructionIndex: 2, customCode: 6001, programNotFound: false } } }),
    );
    expect(out.flags[0]!.description).toBe('Simulation failed: Custom at instruction 2 custom error code 6001.');
  });

  test('simulation unavailable → caution', () => {
    expect(ids(riskInput({ simulation: { status: 'unavailable' } }))).toEqual(['SIMULATION_UNAVAILABLE']);
  });

  test('context flags, once each', () => {
    const context = { unresolvedAccounts: true, amountUnspecified: true, invalidResponses: ['link-server', 'rpc', 'rpc'] as ('rpc' | 'link-server')[] };
    expect(ids(riskInput({ context }))).toEqual([
      'ACCOUNTS_UNRESOLVED',
      'AMOUNT_USER_CHOSEN',
      'INVALID_RESPONSE_RPC',
      'INVALID_RESPONSE_LINK_SERVER',
    ]);
  });
});

describe('engine', () => {
  test('a throwing rule → exactly one RULE_UNEVALUATED, partial flags discarded, never safe', () => {
    const broken: RiskRule = {
      id: 'TOKEN_APPROVE',
      run(_input, out) {
        out.add({ ruleId: 'TOKEN_APPROVE', severity: 'danger', description: 'partial' });
        throw new Error('boom');
      },
    };
    const cannot: RiskRule = {
      id: 'BALANCE_DRAINED',
      run() {
        throw new CannotEvaluate();
      },
    };
    const out = evaluate(riskInput(), [broken, cannot]);
    expect(out.flags).toEqual([
      { ruleId: 'RULE_UNEVALUATED', severity: 'caution', description: 'Risk rule TOKEN_APPROVE could not be evaluated.' },
      { ruleId: 'RULE_UNEVALUATED', severity: 'caution', description: 'Risk rule BALANCE_DRAINED could not be evaluated.' },
    ]);
    expect(out.verdict).toBe('caution');
  });

  test('transfers are recorded without a flag', () => {
    const tokenAcctOwner = addr('Owner11111111111111111111111111111111111111');
    const out = evaluate(
      riskInput({
        topLevel: [
          ix({ kind: 'system-transfer', source: SUBJECT, destination: OTHER, lamports: 1_000_000n }),
          ix({ kind: 'system-transfer', source: OTHER, destination: SUBJECT, lamports: 5n }),
          ix({
            kind: 'token-transfer',
            program: 'spl-token',
            source: TOKEN_ACCOUNT,
            destination: OTHER,
            authority: SUBJECT,
            amount: 7n,
            mint: MINT,
            decimals: 2,
            variant: 'checked',
          }),
        ],
        preTokenAccounts: new Map([[OTHER, { address: OTHER, program: 'spl-token', mint: MINT, owner: tokenAcctOwner, amount: 0n }]]),
        mints: new Map([[MINT, { status: 'ok', address: MINT, program: 'spl-token', decimals: 2, permanentDelegate: null }]]),
      }),
    );
    expect(out.flags).toEqual([]);
    expect(out.verdict).toBe('safe');
    expect(out.transfers).toEqual([
      { asset: { kind: 'sol' }, instruction: 'system-transfer', recipient: OTHER, raw: 1_000_000n, decimals: 9, inner: false },
      {
        asset: { kind: 'token', mint: MINT },
        instruction: 'token-transfer-checked',
        recipient: OTHER,
        recipientOwner: tokenAcctOwner,
        raw: 7n,
        decimals: 2,
        inner: false,
      },
    ]);
  });

  test('deterministic: same input twice → deep-equal output', () => {
    const make = () =>
      riskInput({
        topLevel: [approve(), ix({ kind: 'other' }), ix({ kind: 'system-transfer', source: SUBJECT, destination: OTHER, lamports: 3n })],
        simulation: { status: 'ok', balances: { sol: { pre: 1_000_000n, post: 0n }, tokens: [{ mint: MINT, pre: 1n, post: 0n }] } },
        context: { unresolvedAccounts: true, amountUnspecified: false, invalidResponses: ['rpc'] },
      });
    expect(evaluate(make())).toEqual(evaluate(make()));
  });

  test('RULES keep the design order', () => {
    expect(RULES.slice(0, 13).map((r) => r.id)).toEqual([
      'TOKEN_APPROVE',
      'TOKEN_SET_AUTHORITY',
      'TOKEN_CLOSE_TO_OTHER',
      'MINT_PERMANENT_DELEGATE',
      'BALANCE_DRAINED',
      'UNKNOWN_PROGRAM',
      'SIMULATION_FAILED',
      'SIMULATION_UNAVAILABLE',
      'PERMANENT_DELEGATE_UNCHECKED',
      'ACCOUNTS_UNRESOLVED',
      'AMOUNT_USER_CHOSEN',
      'INVALID_RESPONSE_RPC',
      'INVALID_RESPONSE_LINK_SERVER',
    ]);
  });
});
