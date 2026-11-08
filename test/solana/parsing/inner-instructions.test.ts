/**
 * Synthetic inner-instruction shapes. The (a) jsonParsed records mirror the
 * CPIs Agave reports for an ATA `CreateIdempotent` on an absent account
 * (getAccountDataSize, createAccount, initializeImmutableOwner, initializeAccount3).
 */
import { describe, expect, test } from 'bun:test';
import { address, getBase58Decoder, getBase64Decoder } from '@solana/kit';
import { getTransferCheckedInstructionDataEncoder } from '@solana-program/token';
import { parseInner } from '../../../src/solana/inner-instructions.ts';
import { PROGRAM_IDS, type AccountRef } from '../../../src/solana/types.ts';

const PAYER = 'dv3qDFk1DTF36Z62bNvrCXe9sKATA6xvVy6A798xxAS';
const ATA = 'BCbrryfVtpmWMg5nDRrgwYH25NPDdchpCbDtYV3Mh1VY';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEST = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const UNKNOWN_PROGRAM = 'Vote111111111111111111111111111111111111111';
const TABLE = address('AddressLookupTab1e1111111111111111111111111');

const res = (a: string): AccountRef => ({ kind: 'resolved', address: address(a), writable: false, signer: false });

const ataCpis = [
  {
    index: 1,
    instructions: [
      {
        parsed: { info: { extensionTypes: ['immutableOwner'], mint: MINT }, type: 'getAccountDataSize' },
        program: 'spl-token',
        programId: PROGRAM_IDS.splToken,
        stackHeight: 2,
      },
      {
        parsed: {
          info: { lamports: 2039280, newAccount: ATA, owner: PROGRAM_IDS.splToken, source: PAYER, space: 165 },
          type: 'createAccount',
        },
        program: 'system',
        programId: PROGRAM_IDS.system,
        stackHeight: 2,
      },
      {
        parsed: { info: { account: ATA }, type: 'initializeImmutableOwner' },
        program: 'spl-token',
        programId: PROGRAM_IDS.splToken,
        stackHeight: 2,
      },
      {
        parsed: { info: { account: ATA, mint: MINT, owner: PAYER }, type: 'initializeAccount3' },
        program: 'spl-token',
        programId: PROGRAM_IDS.splToken,
        stackHeight: 2,
      },
    ],
  },
];

describe('parseInner', () => {
  test('(a) jsonParsed ATA CPIs keep order, parent index and stack height', () => {
    const out = parseInner(ataCpis, []);
    if ('error' in out) throw new Error('unexpected error');
    expect(out.map((r): unknown[] => [r.programAddress, r.topLevelIndex, r.inner, r.stackHeight, r.parsed.kind])).toEqual([
      [PROGRAM_IDS.splToken, 1, true, 2, 'other'],
      [PROGRAM_IDS.system, 1, true, 2, 'other'],
      [PROGRAM_IDS.splToken, 1, true, 2, 'other'],
      [PROGRAM_IDS.splToken, 1, true, 2, 'other'],
    ]);
  });

  test('(a) jsonParsed token and system types map to ParsedInstruction', () => {
    const raw = [
      {
        index: 0,
        instructions: [
          {
            program: 'system',
            programId: PROGRAM_IDS.system,
            parsed: { type: 'transfer', info: { source: PAYER, destination: DEST, lamports: 1000000 } },
            stackHeight: 2,
          },
          {
            program: 'spl-token',
            programId: PROGRAM_IDS.splToken,
            parsed: {
              type: 'transferChecked',
              info: {
                source: ATA,
                mint: MINT,
                destination: DEST,
                authority: PAYER,
                tokenAmount: { amount: '18446744073709551615', decimals: 6, uiAmountString: 'x' },
              },
            },
            stackHeight: 3,
          },
          {
            program: 'spl-token',
            programId: PROGRAM_IDS.token2022,
            parsed: { type: 'approve', info: { source: ATA, delegate: DEST, owner: PAYER, amount: '5' } },
          },
          {
            program: 'spl-token',
            programId: PROGRAM_IDS.splToken,
            parsed: {
              type: 'setAuthority',
              info: { account: ATA, authority: PAYER, authorityType: 'closeAccount', newAuthority: DEST },
            },
          },
          {
            program: 'spl-token',
            programId: PROGRAM_IDS.splToken,
            parsed: {
              type: 'setAuthority',
              info: { mint: MINT, multisigAuthority: PAYER, authorityType: 'mintTokens', newAuthority: null },
            },
          },
          {
            program: 'spl-token',
            programId: PROGRAM_IDS.splToken,
            parsed: { type: 'closeAccount', info: { account: ATA, destination: DEST, owner: PAYER } },
          },
          {
            program: 'spl-associated-token-account',
            programId: PROGRAM_IDS.ata,
            parsed: {
              type: 'createIdempotent',
              info: {
                source: PAYER,
                account: ATA,
                wallet: PAYER,
                mint: MINT,
                systemProgram: PROGRAM_IDS.system,
                tokenProgram: PROGRAM_IDS.splToken,
              },
            },
          },
          { program: 'spl-memo', programId: PROGRAM_IDS.memoV2, parsed: 'hello', stackHeight: 2 },
          {
            program: 'spl-token',
            programId: PROGRAM_IDS.splToken,
            parsed: { type: 'transfer', info: { source: ATA, destination: DEST, amount: 'lots' } },
          },
        ],
      },
    ];
    const out = parseInner(raw, []);
    if ('error' in out) throw new Error('unexpected error');
    expect(out.map((r) => r.stackHeight)).toEqual([2, 3, 2, 2, 2, 2, 2, 2, 2]);
    expect(out.map((r) => r.parsed)).toEqual([
      { kind: 'system-transfer', source: address(PAYER), destination: address(DEST), lamports: 1_000_000n },
      {
        kind: 'token-transfer',
        program: 'spl-token',
        source: address(ATA),
        destination: address(DEST),
        authority: address(PAYER),
        amount: 2n ** 64n - 1n,
        mint: address(MINT),
        decimals: 6,
        variant: 'checked',
      },
      {
        kind: 'token-approve',
        program: 'token-2022',
        source: address(ATA),
        delegate: address(DEST),
        owner: address(PAYER),
        amount: 5n,
      },
      {
        kind: 'token-set-authority',
        program: 'spl-token',
        target: address(ATA),
        currentAuthority: address(PAYER),
        authorityType: 'close',
        newAuthority: address(DEST),
      },
      {
        kind: 'token-set-authority',
        program: 'spl-token',
        target: address(MINT),
        currentAuthority: address(PAYER),
        authorityType: 'mint',
        newAuthority: null,
      },
      {
        kind: 'token-close',
        program: 'spl-token',
        account: address(ATA),
        destination: address(DEST),
        authority: address(PAYER),
      },
      {
        kind: 'ata-create',
        wallet: address(PAYER),
        ata: address(ATA),
        mint: address(MINT),
        tokenProgram: address(PROGRAM_IDS.splToken),
      },
      { kind: 'other' },
      { kind: 'unparseable', reason: 'bad-data' },
    ]);
  });

  test('(b) partially decoded: base58 data reuses the compiled parser', () => {
    const data = getBase58Decoder().decode(getTransferCheckedInstructionDataEncoder().encode({ amount: 7n, decimals: 2 }));
    const raw = [
      {
        index: 2,
        instructions: [
          { programId: PROGRAM_IDS.splToken, accounts: [ATA, MINT, DEST, PAYER], data, stackHeight: 2 },
          { programId: UNKNOWN_PROGRAM, accounts: [PAYER], data: '3Bxs4', stackHeight: 3 },
        ],
      },
    ];
    const out = parseInner(raw, []);
    expect(out).toEqual([
      {
        programAddress: address(PROGRAM_IDS.splToken),
        topLevelIndex: 2,
        inner: true,
        stackHeight: 2,
        parsed: {
          kind: 'token-transfer',
          program: 'spl-token',
          source: address(ATA),
          mint: address(MINT),
          destination: address(DEST),
          authority: address(PAYER),
          amount: 7n,
          decimals: 2,
          variant: 'checked',
        },
      },
      { programAddress: address(UNKNOWN_PROGRAM), topLevelIndex: 2, inner: true, stackHeight: 3, parsed: { kind: 'other' } },
    ]);
  });

  test('(c) compiled programIdIndex form resolves against the account list (base58 and base64 data)', () => {
    const bytes = getTransferCheckedInstructionDataEncoder().encode({ amount: 3n, decimals: 0 });
    const accountList: AccountRef[] = [res(PAYER), res(ATA), res(MINT), res(DEST), res(PROGRAM_IDS.splToken)];
    const raw = [
      {
        index: 0,
        instructions: [
          { programIdIndex: 4, accounts: [1, 2, 3, 0], data: getBase58Decoder().decode(bytes) },
          { programIdIndex: 4, accounts: [1, 2, 3, 0], data: getBase64Decoder().decode(bytes), stackHeight: 4 },
        ],
      },
    ];
    const out = parseInner(raw, accountList);
    if ('error' in out) throw new Error('unexpected error');
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r).toMatchObject({
        programAddress: address(PROGRAM_IDS.splToken),
        topLevelIndex: 0,
        inner: true,
        parsed: { kind: 'token-transfer', amount: 3n, source: address(ATA), authority: address(PAYER) },
      });
    }
    expect(out.map((r) => r.stackHeight)).toEqual([2, 4]);
  });

  test('(c) unresolved account in compiled form → unparseable/unresolved-account', () => {
    const bytes = getTransferCheckedInstructionDataEncoder().encode({ amount: 3n, decimals: 0 });
    const accountList: AccountRef[] = [
      res(PAYER),
      { kind: 'unresolved', table: TABLE, index: 0, writable: true },
      res(MINT),
      res(DEST),
      res(PROGRAM_IDS.splToken),
    ];
    const out = parseInner(
      [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [1, 2, 3, 0], data: getBase58Decoder().decode(bytes) }] }],
      accountList,
    );
    if ('error' in out) throw new Error('unexpected error');
    expect(out[0]?.parsed).toEqual({ kind: 'unparseable', reason: 'unresolved-account' });
  });

  test('multiple groups keep returned order', () => {
    const out = parseInner(
      [
        { index: 3, instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '' }] },
        { index: 1, instructions: [{ programId: PROGRAM_IDS.system, accounts: [], data: '' }] },
      ],
      [],
    );
    if ('error' in out) throw new Error('unexpected error');
    expect(out.map((r) => r.topLevelIndex)).toEqual([3, 1]);
  });

  test('empty array → no records', () => {
    expect(parseInner([], [])).toEqual([]);
  });

  test.each([
    ['not an array', { index: 0 }],
    ['null', null],
    ['group without index', [{ instructions: [] }]],
    ['negative index', [{ index: -1, instructions: [] }]],
    ['instructions not an array', [{ index: 0, instructions: {} }]],
    ['instruction not an object', [{ index: 0, instructions: [42] }]],
    ['no recognizable shape', [{ index: 0, instructions: [{ foo: 1 }] }]],
    ['bad programId', [{ index: 0, instructions: [{ programId: 'nope', accounts: [], data: '' }] }]],
    ['bad base58 data', [{ index: 0, instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '0OIl' }] }]],
    ['non-string account', [{ index: 0, instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [1], data: '' }] }]],
    ['programIdIndex out of range', [{ index: 0, instructions: [{ programIdIndex: 9, accounts: [], data: '' }] }]],
    ['account index out of range', [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [5], data: '' }] }]],
    ['bad stackHeight', [{ index: 0, instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '', stackHeight: 'x' }] }]],
    ['parsed with bad programId', [{ index: 0, instructions: [{ programId: 7, parsed: { type: 'transfer', info: {} } }] }]],
  ])('%s → INVALID_RESPONSE_RPC', (_name, raw) => {
    expect(parseInner(raw, [res(PAYER)])).toEqual({ error: 'INVALID_RESPONSE_RPC' });
  });
});
