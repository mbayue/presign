import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { MAX_SUMMARY_CHARS, postprocess } from '../../src/ai/postprocess.ts';

describe('postprocess', () => {
  test('strips closed and unclosed think blocks', () => {
    expect(postprocess('<think>secret plan</think>It sends 1 SOL.')).toBe('It sends 1 SOL.');
    expect(postprocess('It sends 1 SOL. <THINK>still thinking about')).toBe('It sends 1 SOL.');
    expect(postprocess('<think>only reasoning')).toBe('');
  });

  test('strips mentions and mass mentions', () => {
    const out = postprocess('Hi <@123> <@!456> <@&789> in <#42>, @everyone and @here. It swaps tokens.');
    expect(out).toBe('Hi in , and . It swaps tokens.');
    expect(postprocess('@every@hereone look')).not.toContain('@everyone');
  });

  test('strips URLs in every listed form and masked link targets', () => {
    const out = postprocess(
      'See https://evil.test/x and http://a.b www.c.d solana:abc solana-action:https://x [click here](https://bad.test). Done.',
    );
    expect(out).toBe('See and click here. Done.');
    expect(postprocess('Solana: this is fine.')).toBe('Solana: this is fine.');
  });

  test('keeps only the first two sentences', () => {
    expect(postprocess('One. Two!  Three? Four.')).toBe('One. Two!');
    expect(postprocess('Version 1.5 is out. It works')).toBe('Version 1.5 is out. It works');
  });

  test('cuts long text at the last sentence end within 300 chars', () => {
    const first = `${'a'.repeat(150)}.`;
    const second = `${'b '.repeat(200)}end.`;
    expect(postprocess(`${first} ${second}`)).toBe(first);
  });

  test('cuts at whitespace with an ellipsis when no sentence end fits', () => {
    const text = 'word '.repeat(100);
    const out = postprocess(text);
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(out.endsWith('word…')).toBe(true);
    const unbroken = postprocess('x'.repeat(500));
    expect(unbroken).toBe(`${'x'.repeat(299)}…`);
  });

  test('returns empty string when nothing remains', () => {
    expect(postprocess('  <@1> https://x.test  ')).toBe('');
  });

  test('property: bounded, no mass mentions, no URLs, at most two sentence ends', () => {
    const piece = fc.oneof(
      fc.string(),
      fc.constantFrom(
        '@everyone', '@here', '<@1>', '<#2>', 'https://x.test/a', 'http://', 'www.x', 'solana:abc',
        '<think>', '</think>', '[t](https://u)', '. ', '! ', '? ', ' ', 'word',
      ),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (parts) => {
        const out = postprocess(parts.join(''));
        expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
        expect(out).not.toMatch(/@everyone|@here/i);
        expect(out).not.toMatch(/https?:\/\/|www\./i);
        expect(out).not.toMatch(/<think/i);
        expect(out).not.toMatch(/<(?:@[!&]?|#)\d+>/);
        expect([...out.matchAll(/[.!?](?=\s|$)/g)].length).toBeLessThanOrEqual(2);
      }),
      { numRuns: 300 },
    );
  });
});
