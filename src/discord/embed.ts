/**
 * Discord embed for one Safety_Card (Req 11.2–11.6). Untrusted strings pass
 * through discordSanitizer. The visible text of a card (title, description,
 * field names and values, footer) stays within `budget` characters; when
 * Flags do not fit, danger Flags come first and the rest are counted in an
 * "…and N more flags" line.
 */
import { EmbedBuilder } from 'discord.js';
import type { CardModel, FlagLine } from '../render/card-model.ts';
import { discordEscape, discordSanitizer as clean } from '../render/sanitize.ts';

export const CARD_BUDGET = 1_900;
const FIELD_VALUE_MAX = 1_024;
/** postprocess() caps the summary at 300 raw characters; leave room for markdown escapes. */
const AI_SUMMARY_MAX = 420;
const BALANCE_SHARE = 400;
const TRANSFER_SHARE = 250;
const FLAG_RESERVE = 400;

type Field = { name: string; value: string };

/** Joins lines greedily within `limit`, ending with `more(n)` for the dropped lines. */
export function fitLines(lines: readonly string[], limit: number, more: (n: number) => string): string {
  const all = lines.join('\n');
  if (all.length <= limit) return all;
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const tail = more(lines.length - i - 1);
    const next = used + (kept.length > 0 ? 1 : 0) + line.length;
    if (next + 1 + tail.length > limit) break;
    kept.push(line);
    used = next;
  }
  kept.push(more(lines.length - kept.length));
  return kept.join('\n');
}

const SEVERITY_ICON = { danger: '🔴', caution: '🟡' } as const;

const flagText = (f: FlagLine): string =>
  f.severity === 'none' ? f.text : `${SEVERITY_ICON[f.severity]} **${f.ruleId}**: ${f.text}`;

const fieldLength = (f: Field): number => f.name.length + f.value.length;

/** Base58 public keys (32–44 chars) in trusted text → `AjTX…WVXLe`. Discord only; the CLI keeps full addresses. */
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
export const shortenAddresses = (s: string): string => s.replace(ADDRESS_RE, (a) => `${a.slice(0, 4)}…${a.slice(-5)}`);

export function renderEmbed(card: CardModel, budget: number = CARD_BUDGET): EmbedBuilder {
  const title = `${card.emoji} ${card.label}`;
  // The link's own title is the scammer's words, so it is quoted and labelled as such.
  const description = card.title === undefined ? undefined : `Link says: “${clean(card.title)}”`;

  const notes = [...card.clusterNotes];
  if (card.unsupportedClusterValue !== undefined) notes.push(`value: ${clean(card.unsupportedClusterValue)}`);
  const clusterText = notes.length > 0 ? `${card.cluster} (${notes.join('; ')})` : card.cluster;

  // Fixed-size fields; the order on the card is assembled at the end.
  const location: Field = {
    name: `${card.subjectLabel} · Cluster`,
    value: `${shortenAddresses(clean(card.subject))} · ${clusterText}`,
  };
  const ai: Field | undefined =
    card.aiSummary === undefined
      ? undefined
      : { name: card.aiSummary.label, value: discordEscape(card.aiSummary.text, AI_SUMMARY_MAX) };
  const linked: Field | undefined =
    card.linkedActionsNote === undefined ? undefined : { name: 'Linked actions', value: card.linkedActionsNote };
  const explorer: Field = {
    name: 'Explorer',
    value: 'url' in card.explorer ? `[Open in Solana Explorer](${card.explorer.url})` : card.explorer.text,
  };
  const fixed = [location, explorer, ...(ai ? [ai] : []), ...(linked ? [linked] : [])];

  const flagsFull = card.flagLines.map((f) => shortenAddresses(flagText(f)));
  const transferLines = card.transferLines.map(shortenAddresses);
  const balanceLines = card.balanceLines.map(shortenAddresses);
  const flagsNeed = Math.min(flagsFull.join('\n').length, FLAG_RESERVE);
  const transfersNeed = Math.min(transferLines.join('\n').length, TRANSFER_SHARE);

  let avail =
    budget - title.length - (description?.length ?? 0) - card.footer.length - fixed.reduce((n, f) => n + fieldLength(f), 0);

  const balanceName = 'Balance changes';
  avail -= balanceName.length;
  const balances = fitLines(
    balanceLines,
    clamp(avail - flagsNeed - transfersNeed, 60, Math.min(BALANCE_SHARE, FIELD_VALUE_MAX)),
    (n) => `…and ${n} more balance changes`,
  );
  avail -= balances.length;

  let transfers: Field | undefined;
  if (transferLines.length > 0) {
    const name = 'Transfers';
    avail -= name.length;
    const value = fitLines(transferLines, clamp(avail - flagsNeed, 40, TRANSFER_SHARE), (n) => `…and ${n} more transfers`);
    avail -= value.length;
    transfers = { name, value };
  }

  const flagsName = 'Flags';
  avail -= flagsName.length;
  const flags: Field = {
    name: flagsName,
    value: fitLines(flagsFull, clamp(avail, 30, FIELD_VALUE_MAX), (n) => `…and ${n} more flags`),
  };

  // Why first (flags, AI summary), then what moves, then where.
  const ordered: Field[] = [
    flags,
    ...(ai ? [ai] : []),
    { name: balanceName, value: balances },
    ...(transfers ? [transfers] : []),
    ...(linked ? [linked] : []),
    location,
    explorer,
  ];

  const embed = new EmbedBuilder()
    .setColor(card.color)
    .setTitle(title)
    .addFields(...ordered)
    .setFooter({ text: card.footer });
  // No embed-level URL: Discord merges embeds in one message that share a URL,
  // so two links with the same transaction would collapse into one card. The
  // Explorer link stays in its own field.
  if (description !== undefined && description.length > 0) embed.setDescription(description);
  return embed;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Visible characters counted against the card budget. */
export function embedLength(embed: EmbedBuilder): number {
  const d = embed.data;
  return (
    (d.title?.length ?? 0) +
    (d.description?.length ?? 0) +
    (d.footer?.text.length ?? 0) +
    (d.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}
