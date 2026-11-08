import { describe, expect, test } from 'bun:test';
import { extractCandidates } from '../../src/links/candidates.ts';

describe('extractCandidates', () => {
  test('finds all four prefixes with positions in order', () => {
    const text = 'a https://x.example/1 b http://localhost:8787/2 solana:abc solana-action:https://y.example';
    expect(extractCandidates(text)).toEqual([
      { text: 'https://x.example/1', position: 2 },
      { text: 'http://localhost:8787/2', position: 24 },
      { text: 'solana:abc', position: 48 },
    ]);
  });

  test('strips <> and trailing punctuation, and dedupes (Req 1.10)', () => {
    const text = '<https://x.example/a>, https://x.example/a.) (https://x.example/a!?) https://x.example/b';
    expect(extractCandidates(text).map((c) => c.text)).toEqual(['https://x.example/a', 'https://x.example/b']);
  });

  test('keeps only the first 3 distinct candidates (Req 1.9)', () => {
    const text = 'https://a.example https://b.example https://a.example solana:c https://d.example';
    expect(extractCandidates(text).map((c) => c.text)).toEqual(['https://a.example', 'https://b.example', 'solana:c']);
  });

  test('Markdown links yield the inner URL', () => {
    expect(extractCandidates('[click](https://x.example/p)').map((c) => c.text)).toEqual(['https://x.example/p']);
  });

  test('quoted URLs and bare words', () => {
    expect(extractCandidates('"https://q.example" solana is great, solana: maybe')).toEqual([
      { text: 'https://q.example', position: 1 },
    ]);
  });
});
