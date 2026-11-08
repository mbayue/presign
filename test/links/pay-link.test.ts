import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { decimalEquals } from '../../src/links/decimal.ts';
import { parsePayLink, printPayLink } from '../../src/links/pay-link.ts';
import type { PayLinkValue } from '../../src/links/pay-link.ts';
import { arbTransactionRequest, arbTransferRequest } from '../arbitraries/pay.ts';

const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REF = '11111111111111111111111111111111';

/** Equality per Req 3.5: same type, equal strings, numerically equal amount, same references, absent stays absent. */
function payEquals(a: PayLinkValue, b: PayLinkValue): boolean {
  if (a.type === 'transaction' || b.type === 'transaction') {
    return a.type === b.type && a.type === 'transaction' && b.type === 'transaction' && a.link === b.link;
  }
  const sameOptional = (k: 'amount' | 'splToken' | 'label' | 'message' | 'memo') =>
    Object.hasOwn(a, k) === Object.hasOwn(b, k);
  if (!(['amount', 'splToken', 'label', 'message', 'memo'] as const).every(sameOptional)) return false;
  if (a.amount !== undefined && (b.amount === undefined || !decimalEquals(a.amount, b.amount))) return false;
  return (
    a.recipient === b.recipient &&
    a.splToken === b.splToken &&
    a.label === b.label &&
    a.message === b.message &&
    a.memo === b.memo &&
    a.references.length === b.references.length &&
    a.references.every((r, i) => r === b.references[i])
  );
}

describe('Pay_Link round trip', () => {
  // Feature: solana-scanner-bot, Property 12: Solana Pay round trip
  test('parse(print(x)) equals x for valid Transfer_Requests and Transaction_Requests', () => {
    fc.assert(
      fc.property(fc.oneof(arbTransferRequest, arbTransactionRequest), (value) => {
        const printed = printPayLink(value);
        if (!printed.ok) throw new Error(`printer rejected valid value: ${JSON.stringify(printed.error)}`);
        const amount = /[?&]amount=([^&]*)/.exec(printed.url)?.[1];
        if (amount !== undefined && !/^\d+(\.\d+)?$/.test(amount)) throw new Error(`non-plain amount ${amount}`);
        const parsed = parsePayLink(printed.url);
        if (!parsed.ok) throw new Error(`parser rejected ${printed.url}: ${JSON.stringify(parsed.error)}`);
        return payEquals(value, parsed.value);
      }),
      { numRuns: 200 },
    );
  });
});

describe('parsePayLink', () => {
  test('parses a full Transfer_Request', () => {
    const r = parsePayLink(
      `solana:${RECIPIENT}?amount=1.50&spl-token=${MINT}&reference=${REF}&label=Coffee%20Shop&message=Thanks!&memo=order%231&foo=bar`,
      { decimals: 6 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.type !== 'transfer') return;
    expect(r.value.recipient).toBe(RECIPIENT as typeof r.value.recipient);
    expect(r.value.amount).toEqual({ digits: 150n, scale: 2 });
    expect(r.value.splToken).toBe(MINT as typeof r.value.recipient);
    expect(r.value.references).toEqual([REF as typeof r.value.recipient]);
    expect(r.value.label).toBe('Coffee Shop');
    expect(r.value.message).toBe('Thanks!');
    expect(r.value.memo).toBe('order#1');
  });

  test('parses a Transaction_Request and ignores the outer query', () => {
    const r = parsePayLink('solana:https%3A%2F%2Fpay.example.com%2Ftx%3Forder%3D7?label=ignored');
    expect(r).toEqual({ ok: true, value: { type: 'transaction', link: 'https://pay.example.com/tx?order=7' } });
  });

  test('accepts an allowlisted http dev origin as a Transaction_Request', () => {
    const r = parsePayLink('solana:http%3A%2F%2Flocalhost%3A8787%2Ftx');
    expect(r).toEqual({ ok: true, value: { type: 'transaction', link: 'http://localhost:8787/tx' } });
  });

  const errors: [string, string, string][] = [
    ['empty path', 'solana:', 'path'],
    ['bad recipient', 'solana:notbase58!!', 'recipient'],
    ['short recipient', 'solana:1111', 'recipient'],
    ['negative amount', `solana:${RECIPIENT}?amount=-1`, 'amount'],
    ['exponent amount', `solana:${RECIPIENT}?amount=1e9`, 'amount'],
    ['trailing dot amount', `solana:${RECIPIENT}?amount=1.`, 'amount'],
    ['too many SOL decimals', `solana:${RECIPIENT}?amount=0.0000000001`, 'amount'],
    ['amount above u64', `solana:${RECIPIENT}?amount=18446744074`, 'amount'],
    ['duplicated amount', `solana:${RECIPIENT}?amount=1&amount=2`, 'amount'],
    ['duplicated label', `solana:${RECIPIENT}?label=a&label=b`, 'label'],
    ['duplicated memo', `solana:${RECIPIENT}?memo=a&memo=b`, 'memo'],
    ['bad spl-token', `solana:${RECIPIENT}?spl-token=xyz`, 'spl-token'],
    ['bad reference', `solana:${RECIPIENT}?reference=0OIl`, 'reference'],
    ['11 references', `solana:${RECIPIENT}?${Array.from({ length: 11 }, () => `reference=${REF}`).join('&')}`, 'reference'],
    ['ftp link', 'solana:ftp%3A%2F%2Fexample.com%2Ftx', 'link'],
    ['non-allowlisted http link', 'solana:http%3A%2F%2Fexample.com%2Ftx', 'link'],
    ['too long', `solana:${RECIPIENT}?label=${'a'.repeat(4_100)}`, 'url'],
  ];
  for (const [name, url, part] of errors) {
    test(`rejects ${name}`, () => {
      const r = parsePayLink(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.part).toBe(part as typeof r.error.part);
    });
  }

  test('spl-token amount decimals are checked only when supplied', () => {
    const url = `solana:${RECIPIENT}?amount=0.1234567&spl-token=${MINT}`;
    expect(parsePayLink(url).ok).toBe(true);
    const r = parsePayLink(url, { decimals: 6 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.part).toBe('amount');
  });

  test('10 references are accepted in URL order', () => {
    const r = parsePayLink(`solana:${RECIPIENT}?${Array.from({ length: 10 }, () => `reference=${REF}`).join('&')}`);
    expect(r.ok && r.value.type === 'transfer' && r.value.references.length).toBe(10);
  });
});

describe('printPayLink', () => {
  test('rejects an invalid structure naming the field (Req 3.7)', () => {
    const r = printPayLink({
      type: 'transfer',
      recipient: RECIPIENT as never,
      amount: { digits: 1n, scale: 10 },
      references: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.part).toBe('amount');
  });

  test('rejects a non-https Transaction_Request link', () => {
    const r = printPayLink({ type: 'transaction', link: 'ftp://example.com/x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.part).toBe('link');
  });

  test('writes plain decimals and percent-encodes text and links', () => {
    const t = printPayLink({
      type: 'transfer',
      recipient: RECIPIENT as never,
      amount: { digits: 5n, scale: 9 },
      references: [],
      label: 'a b&c',
    });
    expect(t).toEqual({ ok: true, url: `solana:${RECIPIENT}?amount=0.000000005&label=a%20b%26c` });
    const l = printPayLink({ type: 'transaction', link: 'https://x.example/tx?a=1' });
    expect(l).toEqual({ ok: true, url: 'solana:https%3A%2F%2Fx.example%2Ftx%3Fa%3D1' });
  });
});
