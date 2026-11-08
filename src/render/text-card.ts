/**
 * Plain-text Safety_Card for the Scan_CLI (Req 15.1). Every Flag and
 * Balance_Change is listed; untrusted text passes through terminalSanitizer.
 */
import type { ScanResult } from '../scan/types.ts';
import { RAW_TRANSACTION_SUBJECT, toCardModel, type CardModel } from './card-model.ts';
import { terminalSanitizer as clean } from './sanitize.ts';

export function renderCardText(card: CardModel): string {
  const lines: string[] = [];
  lines.push(`Source: ${card.source === null ? RAW_TRANSACTION_SUBJECT : clean(card.source)}`);
  lines.push(`${card.subjectLabel}: ${clean(card.subject)}`);
  if (card.title !== undefined) lines.push(`Link says: "${clean(card.title)}"`);
  const notes = [...card.clusterNotes];
  if (card.unsupportedClusterValue !== undefined) notes.push(`value: ${clean(card.unsupportedClusterValue)}`);
  lines.push(`Cluster: ${card.cluster}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`);
  lines.push(`Verdict: ${card.emoji} ${card.label}`);
  lines.push('', 'Flags:');
  for (const f of card.flagLines) {
    lines.push(f.severity === 'none' ? `  ${f.text}` : `  [${f.severity}] ${f.ruleId}: ${clean(f.text)}`);
  }
  lines.push('', 'Balance changes:');
  for (const b of card.balanceLines) lines.push(`  ${b}`);
  if (card.transferLines.length > 0) {
    lines.push('', 'Transfers:');
    for (const t of card.transferLines) lines.push(`  ${t}`);
  }
  if (card.linkedActionsNote !== undefined) lines.push('', card.linkedActionsNote);
  if (card.aiSummary !== undefined) lines.push('', `${card.aiSummary.label}: ${clean(card.aiSummary.text)}`);
  lines.push('', `Explorer: ${'url' in card.explorer ? card.explorer.url : card.explorer.text}`);
  lines.push('', card.footer);
  return `${lines.join('\n')}\n`;
}

export function renderText(result: ScanResult): string {
  return renderCardText(toCardModel(result));
}
