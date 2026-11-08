import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifySyntactic, detectLinks, shouldScanMessage } from '../../src/links/detector.ts';
import type { ActionsJsonResolution, ActionsJsonResolver } from '../../src/fetch/types.ts';
import type { ScannableLink } from '../../src/scan/types.ts';

type Expected = { kind: ScannableLink['kind']; via?: string; target: string };
type MessageFixture = {
  description: string;
  text: string;
  actionsJson: Record<string, ActionsJsonResolution>;
  expected: Expected[];
};

const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'messages');

/** Fake resolver backed by a fixture map; unknown URLs are "not found" (not-blink). */
function fakeResolver(map: Record<string, ActionsJsonResolution>, throwFor: readonly string[] = []) {
  const calls: string[] = [];
  const resolver: ActionsJsonResolver = {
    async resolve(url) {
      calls.push(url);
      if (throwFor.includes(url)) throw new Error('network error');
      return map[url] ?? { kind: 'not-blink' };
    },
  };
  return { resolver, calls };
}

function summarize(link: ScannableLink): Expected {
  switch (link.kind) {
    case 'blink':
      return { kind: link.kind, via: link.via, target: link.actionUrl };
    case 'transfer-request':
      return { kind: link.kind, target: link.request.recipient };
    case 'transaction-request':
      return { kind: link.kind, target: link.request.link };
  }
}

describe('Link_Detector fixtures', () => {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  test('fixture set covers every link form and the three negatives (Req 19.4, 19.5)', () => {
    for (const required of [
      'solana-action.json',
      'dial-to.json',
      'actions-json-blink.json',
      'transfer-request.json',
      'transaction-request.json',
      'negative-word-solana.json',
      'negative-actions-json-not-found.json',
      'negative-no-url.json',
    ]) {
      expect(files).toContain(required);
    }
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as MessageFixture;
    test(`test/fixtures/messages/${file}: ${fixture.description}`, async () => {
      const { resolver } = fakeResolver(fixture.actionsJson);
      const links = await detectLinks(fixture.text, { actions: resolver });
      expect(links.map(summarize)).toEqual(fixture.expected);
    });
  }
});

describe('detectLinks', () => {
  test('a resolver throw drops only that candidate', async () => {
    const { resolver, calls } = fakeResolver(
      { 'https://ok.example.com/a': { kind: 'blink', via: 'direct', actionUrl: 'https://ok.example.com/a' } },
      ['https://down.example.com/x'],
    );
    const links = await detectLinks('https://down.example.com/x then https://ok.example.com/a', {
      actions: resolver,
    });
    expect(links.map(summarize)).toEqual([{ kind: 'blink', via: 'direct', target: 'https://ok.example.com/a' }]);
    expect(calls).toEqual(['https://down.example.com/x', 'https://ok.example.com/a']);
  });

  test('raw is the stripped candidate text', async () => {
    const { resolver } = fakeResolver({});
    const links = await detectLinks('<solana-action:https://a.example.com/api>.', { actions: resolver });
    expect(links[0]?.raw).toBe('solana-action:https://a.example.com/api');
  });

  test('no network probe for syntactic links or non-allowlisted http', async () => {
    const { resolver, calls } = fakeResolver({});
    await detectLinks('http://evil.example.com/x solana-action:https://a.example.com/api', { actions: resolver });
    expect(calls).toEqual([]);
  });
});

describe('classifySyntactic', () => {
  const cases: [string, string][] = [
    ['solana-action:http://evil.example.com/api', 'none'],
    ['solana-action:http://localhost:8787/api/demo', 'blink'],
    ['solana-action:not-a-url', 'none'],
    ['https://dial.to/?action=ftp%3A%2F%2Fx.example', 'none'],
    ['https://dial.to/?action=', 'probe'],
    ['https://www.dial.to/?action=solana-action%3Ahttps%3A%2F%2Fa.example', 'probe'],
    ['https://dial.to/?action=https%3A%2F%2Fa.example%2Fapi', 'blink'],
    ['http://example.com/', 'none'],
    ['http://localhost:8787/blink', 'probe'],
    ['https://example.com/page', 'probe'],
    ['solana:notbase58', 'none'],
    ['solana:ftp%3A%2F%2Fexample.com', 'none'],
  ];
  for (const [input, kind] of cases) {
    test(`${input} → ${kind}`, () => {
      expect(classifySyntactic(input).kind).toBe(kind as ReturnType<typeof classifySyntactic>['kind']);
    });
  }

  test('dial.to strips the solana-action: prefix', () => {
    expect(classifySyntactic('https://dial.to/?action=solana-action:https://a.example/api')).toEqual({
      kind: 'blink',
      via: 'dial.to',
      actionUrl: 'https://a.example/api',
    });
  });
});

describe('shouldScanMessage', () => {
  const base = { inGuild: true, authorIsBot: false, channelId: 'c1', watched: [] as string[], botCanViewChannel: true };
  test('empty watched list watches every viewable channel', () => {
    expect(shouldScanMessage(base)).toBe(true);
    expect(shouldScanMessage({ ...base, botCanViewChannel: false })).toBe(false);
  });
  test('watched list restricts channels', () => {
    expect(shouldScanMessage({ ...base, watched: ['c1'] })).toBe(true);
    expect(shouldScanMessage({ ...base, watched: ['c2'] })).toBe(false);
  });
  test('DMs and bot authors are skipped', () => {
    expect(shouldScanMessage({ ...base, inGuild: false })).toBe(false);
    expect(shouldScanMessage({ ...base, authorIsBot: true })).toBe(false);
  });
});
