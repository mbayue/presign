/**
 * Scan_CLI: `bun run scan <input> [--cluster devnet|mainnet]` (Req 15).
 * Runs the same pipeline as the Discord bot without Discord or a bot token.
 *
 * Exit codes: 0 for any Scan_Result (🟢, 🟡 or 🔴), 1 when no result could be
 * produced, 2 for usage errors.
 */
import { parseConfig, type Config } from '../config.ts';
import { createActionsJsonResolver } from '../fetch/actions-json.ts';
import type { ActionsJsonResolver } from '../fetch/types.ts';
import { classifySyntactic } from '../links/detector.ts';
import { renderText } from '../render/text-card.ts';
import { createPipelineDeps, scanLink, type PipelineDeps } from '../scan/pipeline.ts';
import type { Cluster, ScanInput, ScanResult } from '../scan/types.ts';

export const USAGE = [
  'Usage: bun run scan <input> [--cluster devnet|mainnet]',
  '',
  'Accepted inputs:',
  '  solana-action:<url>                 Solana Action (blink) URI',
  '  https://dial.to/?action=<url>       dial.to blink',
  '  https://<site>/<path>               any HTTPS link served as a blink (actions.json)',
  '  solana:<recipient>?amount=...       Solana Pay transfer request',
  '  solana:<https-url>                  Solana Pay transaction request',
  '  <base64>                            a raw base64 wire transaction',
].join('\n');

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ParsedArgs = { ok: true; input: string; cluster?: Cluster } | { ok: false; reason: string };

/** One positional input and an optional `--cluster devnet|mainnet` (Req 15.6). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let cluster: Cluster | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--cluster' || arg.startsWith('--cluster=')) {
      const value = arg === '--cluster' ? argv[++i] : arg.slice('--cluster='.length);
      if (value !== 'devnet' && value !== 'mainnet') return { ok: false, reason: '--cluster must be devnet or mainnet' };
      cluster = value;
      continue;
    }
    if (arg.startsWith('--')) return { ok: false, reason: `unknown option ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return { ok: false, reason: positional.length === 0 ? 'missing input' : 'expected exactly one input' };
  }
  return cluster === undefined ? { ok: true, input: positional[0]! } : { ok: true, input: positional[0]!, cluster };
}

export type CliInput =
  | { kind: 'scan'; input: ScanInput }
  | { kind: 'not-scannable' }
  | { kind: 'unrecognized' };

/** A Solana link always wins over base64 interpretation (Req 15.8). */
export async function classifyCliInput(raw: string, resolver: ActionsJsonResolver): Promise<CliInput> {
  const text = raw.trim();
  const looksLikeLink = /^(https?:\/\/|solana:|solana-action:)/i.test(text);
  if (looksLikeLink) {
    const cls = classifySyntactic(text);
    switch (cls.kind) {
      case 'blink':
        return { kind: 'scan', input: { kind: 'link', link: { kind: 'blink', raw: text, via: cls.via, actionUrl: cls.actionUrl } } };
      case 'transfer-request':
        return { kind: 'scan', input: { kind: 'link', link: { kind: 'transfer-request', raw: text, request: cls.request } } };
      case 'transaction-request':
        return {
          kind: 'scan',
          input: { kind: 'link', link: { kind: 'transaction-request', raw: text, request: cls.request } },
        };
      case 'probe': {
        const res = await resolver.resolve(cls.url).catch(() => ({ kind: 'not-blink' as const }));
        if (res.kind === 'blink') {
          return { kind: 'scan', input: { kind: 'link', link: { kind: 'blink', raw: text, via: res.via, actionUrl: res.actionUrl } } };
        }
        return { kind: 'not-scannable' };
      }
      case 'none':
        return { kind: 'not-scannable' };
    }
  }
  if (BASE64_RE.test(text)) return { kind: 'scan', input: { kind: 'raw-transaction', base64: text } };
  return { kind: 'unrecognized' };
}

export interface CliIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

const processIo: CliIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

/** Returns the exit code. `env` and `overrides` are injectable for tests. */
export async function runCli(
  argv: readonly string[],
  opts: {
    env?: Record<string, string | undefined>;
    io?: CliIo;
    deps?: Partial<PipelineDeps>;
    resolver?: ActionsJsonResolver;
    scan?: (input: ScanInput, cluster: Cluster | undefined, deps: PipelineDeps) => Promise<ScanResult>;
  } = {},
): Promise<number> {
  const io = opts.io ?? processIo;
  const args = parseArgs(argv);
  if (!args.ok) {
    io.stderr(`Error: ${args.reason}\n\n${USAGE}\n`);
    return 2;
  }

  const parsed = parseConfig(opts.env ?? process.env);
  if ('errors' in parsed) {
    for (const e of parsed.errors) io.stderr(`Invalid configuration: ${e.variable} ${e.reason}\n`);
    return 1;
  }
  const config: Config = parsed.config;
  const deps = createPipelineDeps(config, opts.deps ?? {});
  const resolver = opts.resolver ?? createActionsJsonResolver(deps.http);

  let classified: CliInput;
  try {
    classified = await classifyCliInput(args.input, resolver);
  } catch {
    io.stderr('Error: link detection failed\n');
    return 1;
  }
  if (classified.kind === 'unrecognized') {
    io.stderr(`Error: input is not a supported link or base64 transaction\n\n${USAGE}\n`);
    return 2;
  }
  if (classified.kind === 'not-scannable') {
    io.stdout('This link is not scannable: it is not a Solana Action, Solana Pay link, or an allowed URL.\n');
    return 0;
  }

  const run =
    opts.scan ??
    ((input: ScanInput, cluster: Cluster | undefined, d: PipelineDeps) =>
      scanLink(input, cluster === undefined ? {} : { clusterOverride: cluster }, d));

  let result: ScanResult;
  try {
    result = await run(classified.input, args.cluster, deps);
  } catch {
    io.stderr('Error: the scan pipeline failed before producing a result (stage: scan)\n');
    return 1;
  }
  io.stdout(`${renderText(result)}\n`);
  return 0;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
