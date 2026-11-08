import { describe, expect, test } from 'bun:test';
import { address } from '@solana/kit';
import { embedLength, renderEmbed } from '../../src/discord/embed.ts';
import { flagTemplates } from '../../src/risk/flags.ts';
import {
  APPROVE_NO_BALANCE_LINE,
  APPROVE_NOTE_LINE,
  NO_BALANCE_LINE,
  NO_FLAGS_LINE,
  toCardModel,
} from '../../src/render/card-model.ts';
import { discordSanitizer, terminalSanitizer } from '../../src/render/sanitize.ts';
import { renderText } from '../../src/render/text-card.ts';
import { untrusted, type Flag } from '../../src/scan/types.ts';
import { DELEGATE, MINT, scanResult, TOKEN_ACCOUNT, UNKNOWN_PROG } from '../arbitraries/risk.ts';

describe('discordSanitizer', () => {
  test('escapes markdown and breaks mentions', () => {
    const out = discordSanitizer(untrusted('**bold** _x_ ~~s~~ ||spoiler|| [a](b) # h > q `c` @everyone <@123>'));
    expect(out).toBe(
      '\\*\\*bold\\*\\* \\_x\\_ \\~\\~s\\~\\~ \\|\\|spoiler\\|\\| \\[a\\]\\(b\\) \\# h \\> q \\`c\\` @\u200Beveryone <\u200B@\u200B123\\>',
    );
  });

  test('escapes leading list markers', () => {
    expect(discordSanitizer('- item')).toBe('\\- item');
    expect(discordSanitizer('1. item')).toBe('1\\. item');
    expect(discordSanitizer('+ item')).toBe('\\+ item');
  });

  test('defangs URLs as inline code with backticks removed', () => {
    expect(discordSanitizer(untrusted('claim at https://ev`il.com/x_y now'))).toBe('claim at `https://evil.com/x_y` now');
    expect(discordSanitizer('solana-action:https://a.b')).toBe('`solana-action:https://a.b`');
    expect(discordSanitizer('www.evil.com')).toBe('`www.evil.com`');
  });

  test('truncates to 100 characters including …', () => {
    const out = discordSanitizer('a'.repeat(250));
    expect(out).toHaveLength(100);
    expect(out.endsWith('…')).toBe(true);
    const url = discordSanitizer(`see https://${'x'.repeat(300)}`);
    expect(url.length).toBeLessThanOrEqual(100);
    expect(url.endsWith('`…')).toBe(true);
    expect((url.match(/`/g) ?? []).length).toBe(2);
    expect(discordSanitizer('*'.repeat(80)).length).toBeLessThanOrEqual(100);
    expect(discordSanitizer('*'.repeat(80)).endsWith('\\*…')).toBe(true);
  });

  test('removes newlines', () => {
    expect(discordSanitizer('a\n# b')).toBe('a \\# b');
  });
});

describe('terminalSanitizer', () => {
  test('strips ESC sequences and control characters', () => {
    const out = terminalSanitizer(untrusted('\u001B[31mred\u001B[0m\u001B]0;title\u0007 ok\u0000\u009B2J\nnext'));
    expect(out).toBe('red ok next');
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(out)).toBe(false);
  });
});

const flags: Flag[] = [
  flagTemplates.UNKNOWN_PROGRAM({ program: UNKNOWN_PROG }),
  flagTemplates.TOKEN_APPROVE({ delegate: DELEGATE, tokenAccount: TOKEN_ACCOUNT, raw: 5n }),
  flagTemplates.SIMULATION_UNAVAILABLE(),
];

describe('toCardModel', () => {
  test('empty result shows placeholder lines', () => {
    const card = toCardModel(scanResult());
    expect(card.emoji).toBe('🟢');
    expect(card.label).toBe('No risky actions found');
    expect(card.color).toBe(0x2ecc71);
    expect(card.subject).toBe('example.com');
    expect(card.balanceLines).toEqual([NO_BALANCE_LINE]);
    expect(card.flagLines).toEqual([{ severity: 'none', text: NO_FLAGS_LINE }]);
    expect(card.footer).toContain('placeholder account');
  });

  test('danger first, signed balance lines, notes', () => {
    const card = toCardModel(
      scanResult({
        verdict: 'danger',
        flags,
        link: { raw: 'solana:abc', kind: 'transfer-request', recipient: DELEGATE },
        clusterInfo: { source: 'outer', fallbackFrom: 'mainnet', unsupportedValue: untrusted('testnet') },
        balanceChanges: [
          { asset: { kind: 'sol' }, rawDelta: -1_000_000n, decimals: 9, pre: 2_000_000n, post: 1_000_000n },
          { asset: { kind: 'token', mint: MINT }, rawDelta: 5n, decimals: 'unknown', pre: 0n, post: 5n },
        ],
        explorer: { none: true },
        linkedActionsNotScanned: 2,
        aiSummary: 'This asks for approval.',
      }),
    );
    expect(card.color).toBe(0xe74c3c);
    expect(card.subject).toBe(DELEGATE);
    expect(card.flagLines.map((f) => f.severity)).toEqual(['danger', 'caution', 'caution']);
    expect(card.flagLines[1]!.text).toBe(flags[0]!.description);
    expect(card.balanceLines).toEqual(['Sends 0.001 SOL', `Receives 5 base units of ${MINT}`, APPROVE_NOTE_LINE]);
    expect(card.clusterNotes).toEqual(['Fell back from mainnet', 'Unsupported cluster value ignored']);
    expect(card.unsupportedClusterValue).toBe(untrusted('testnet'));
    expect(card.explorer).toEqual({ none: true, text: 'No Explorer link available' });
    expect(card.linkedActionsNote).toBe('2 linked actions were not scanned.');
    expect(card.aiSummary?.label).toBe('AI summary (AI-generated)');
  });

  test('raw transaction subject', () => {
    expect(toCardModel(scanResult({ link: { raw: null, kind: 'raw-transaction' } })).subject).toBe('Raw transaction');
  });
});

describe('renderText', () => {
  test('lists every flag and sanitizes untrusted text', () => {
    const text = renderText(
      scanResult({
        verdict: 'danger',
        flags,
        link: { raw: 'https://evil.com/\u001B[2Jx', kind: 'blink', host: 'evil.com' },
        metadata: { title: untrusted('Free \u001B[31mNFT') },
        aiSummary: 'Summary here.',
      }),
    );
    for (const f of flags) expect(text).toContain(`[${f.severity}] ${f.ruleId}: ${f.description}`);
    expect(text).toContain('Source: https://evil.com/x');
    expect(text).toContain('Link host: evil.com');
    expect(text).toContain('Link says: "Free NFT"');
    expect(text).toContain('Cluster: devnet');
    expect(text).toContain('Verdict: 🔴 Danger');
    expect(text).toContain(APPROVE_NO_BALANCE_LINE);
    expect(text).toContain('AI summary (AI-generated): Summary here.');
    expect(text).toContain('Explorer: https://explorer.solana.com/');
    expect(text).toContain('does not guarantee safety');
    expect(text.includes('\u001B')).toBe(false);
  });
});

describe('renderEmbed', () => {
  test('color, title, fields', () => {
    const embed = renderEmbed(toCardModel(scanResult({ verdict: 'caution', flags: [flags[0]!], aiSummary: 'Hi.' })));
    expect(embed.data.color).toBe(0xf1c40f);
    expect(embed.data.title).toBe('🟡 Caution');
    const names = (embed.data.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Flags', 'AI summary (AI-generated)', 'Balance changes', 'Link host · Cluster', 'Explorer']);
  });

  test('addresses in trusted lines are shortened on Discord', () => {
    const real = address('AjTXzfxCuiDhuZhC6fdLmkS1fzmMbd1439ekrGqWVXLe');
    const flag = flagTemplates.TOKEN_APPROVE({ delegate: real, tokenAccount: real, raw: 5n });
    const embed = renderEmbed(toCardModel(scanResult({ verdict: 'danger', flags: [flag] })));
    const value = embed.data.fields?.find((f) => f.name === 'Flags')?.value ?? '';
    expect(value).not.toContain(real);
    expect(value).toContain('AjTX…WVXLe');
  });

  test('the link title is quoted and labelled as the link\'s own words', () => {
    const embed = renderEmbed(toCardModel(scanResult({ metadata: { title: untrusted('Claim your free airdrop') } })));
    expect(embed.data.description).toBe('Link says: “Claim your free airdrop”');
  });

  test('flag overflow stays within budget, danger first, counts the rest', () => {
    const many: Flag[] = [
      ...Array.from({ length: 30 }, () => flagTemplates.UNKNOWN_PROGRAM({ program: UNKNOWN_PROG })),
      flagTemplates.TOKEN_APPROVE({ delegate: DELEGATE, tokenAccount: TOKEN_ACCOUNT, raw: 5n }),
    ];
    const embed = renderEmbed(toCardModel(scanResult({ verdict: 'danger', flags: many, aiSummary: 'x'.repeat(300) })));
    expect(embedLength(embed)).toBeLessThanOrEqual(1_900);
    const value = embed.data.fields?.find((f) => f.name === 'Flags')?.value ?? '';
    expect(value.startsWith('🔴 **Token spending approval**')).toBe(true);
    expect(value).toMatch(/…and \d+ more flags$/);
  });
});

describe('renderEmbed embed URL', () => {
  // Discord merges embeds in one message that share a URL, which hid one of two
  // identical-transaction cards in the live test. The Explorer link must stay in a field.
  test('cards with the same Explorer link have no embed-level URL', () => {
    const url = 'https://explorer.solana.com/tx/inspector?cluster=devnet&message=abc';
    const result = scanResult({ explorer: { url } });
    const a = renderEmbed(toCardModel(result)).toJSON();
    const b = renderEmbed(toCardModel(result)).toJSON();
    expect(a.url).toBeUndefined();
    expect(b.url).toBeUndefined();
    expect(a.fields?.find((f) => f.name === 'Explorer')?.value).toContain(url);
  });
});
