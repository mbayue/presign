/**
 * Task 18.3: Scan_CLI exit codes and input classification (Req 15.2, 15.4,
 * 15.5, 15.6, 15.7, 15.8). Results come from the pipeline fixtures in
 * test/scan/pipeline-fixtures/; nothing touches the network.
 */
import { describe, expect, test } from 'bun:test';
import { DEMO, safeTransaction } from '../../demo/transactions.ts';
import { classifyCliInput, type CliIo, parseArgs, runCli, USAGE } from '../../src/cli/scan.ts';
import { renderText } from '../../src/render/text-card.ts';
import { scanLink } from '../../src/scan/pipeline.ts';
import type { Cluster, ScanInput, ScanResult } from '../../src/scan/types.ts';
import fundedSafeJson from '../scan/pipeline-fixtures/funded-placeholder-safe.json' with { type: 'json' };
import unfundedJson from '../scan/pipeline-fixtures/unfunded-placeholder.json' with { type: 'json' };
import {
  createDemoHttp,
  createTableRpcs,
  DEMO_LINKS,
  fixtureDeps,
  fixtureNames,
  noProbeResolver,
  type RpcFixture,
  scanInputFor,
  SUBJECT,
} from '../scan/pipeline-fixtures/harness.ts';

const unfunded = unfundedJson as RpcFixture;
const fundedSafe = fundedSafeJson as RpcFixture;
const names = await fixtureNames();

function captureIo(): CliIo & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(s: string) {
      io.out += s;
    },
    stderr(s: string) {
      io.err += s;
    },
  };
  return io;
}

async function fixtureResult(link: string, fixture: RpcFixture): Promise<ScanResult> {
  const { deps } = fixtureDeps(fixture, names);
  return scanLink(await scanInputFor(link), {}, deps);
}

/** Deps for runCli: fake RPC and the demo server, no AI, no env. */
function cliOpts(fixture: RpcFixture) {
  const { rpcs } = createTableRpcs(fixture, names);
  return { env: {}, deps: { rpcs, http: createDemoHttp().http, ai: null }, resolver: noProbeResolver };
}

describe('runCli exit codes (Req 15.4, 15.7)', () => {
  const cases: { name: string; link: string; fixture: RpcFixture; emoji: string }[] = [
    { name: 'funded-placeholder-safe.json: 🟢 safe', link: DEMO_LINKS.safe, fixture: fundedSafe, emoji: '🟢' },
    { name: 'unfunded-placeholder.json: 🟡 safe', link: DEMO_LINKS.safe, fixture: unfunded, emoji: '🟡' },
    { name: 'unfunded-placeholder.json: 🔴 drainer', link: DEMO_LINKS.drainer, fixture: unfunded, emoji: '🔴' },
  ];

  for (const c of cases) {
    test(`${c.name} → exit 0 with the card on stdout`, async () => {
      const result = await fixtureResult(c.link, c.fixture);
      const io = captureIo();
      const seen: { input: ScanInput; cluster: Cluster | undefined }[] = [];
      const code = await runCli([c.link], {
        ...cliOpts(c.fixture),
        io,
        scan: async (input, cluster) => {
          seen.push({ input, cluster });
          return result;
        },
      });
      expect(code).toBe(0);
      expect(io.out).toBe(`${renderText(result)}\n`);
      expect(io.out).toContain(`Verdict: ${c.emoji}`);
      expect(io.err).toBe('');
      expect(seen).toEqual([{ input: await scanInputFor(c.link), cluster: undefined }]);
    });
  }

  test('unfunded-placeholder.json: real pipeline via runCli prints the same card as scanLink', async () => {
    const expected = renderText(await fixtureResult(DEMO_LINKS.drainer, unfunded));
    const io = captureIo();
    const code = await runCli([DEMO_LINKS.drainer], { ...cliOpts(unfunded), io });
    expect(code).toBe(0);
    expect(io.out).toBe(`${expected}\n`);
    expect(io.out).toContain('Verdict: 🔴 Danger');
    expect(io.out).toContain('UNLIMITED');
  });

  test('--cluster devnet is passed to the scan as an override', async () => {
    const result = await fixtureResult(DEMO_LINKS.safe, fundedSafe);
    let cluster: Cluster | undefined;
    const code = await runCli([DEMO_LINKS.safe, '--cluster', 'devnet'], {
      ...cliOpts(fundedSafe),
      io: captureIo(),
      scan: async (_input, c) => {
        cluster = c;
        return result;
      },
    });
    expect(code).toBe(0);
    expect(cluster).toBe('devnet');
  });

  test('a scan that throws → exit 1 naming the stage on stderr, nothing on stdout', async () => {
    const io = captureIo();
    const code = await runCli([DEMO_LINKS.drainer], {
      ...cliOpts(unfunded),
      io,
      scan: async () => {
        throw new Error('boom');
      },
    });
    expect(code).toBe(1);
    expect(io.err).toContain('stage');
    expect(io.err).not.toContain('boom');
    expect(io.out).toBe('');
  });

  const usageCases: { name: string; argv: string[]; reason: string }[] = [
    { name: 'no arguments', argv: [], reason: 'missing input' },
    { name: 'two inputs', argv: [DEMO_LINKS.safe, DEMO_LINKS.drainer], reason: 'expected exactly one input' },
    { name: '--cluster testnet', argv: [DEMO_LINKS.safe, '--cluster', 'testnet'], reason: '--cluster must be devnet or mainnet' },
  ];
  for (const u of usageCases) {
    test(`${u.name} → exit 2 with usage on stderr`, async () => {
      const io = captureIo();
      let scanned = false;
      const code = await runCli(u.argv, {
        ...cliOpts(unfunded),
        io,
        scan: async () => {
          scanned = true;
          throw new Error('must not scan');
        },
      });
      expect(code).toBe(2);
      expect(io.err).toContain(u.reason);
      expect(io.err).toContain(USAGE);
      expect(io.out).toBe('');
      expect(scanned).toBe(false);
    });
  }
});

describe('parseArgs', () => {
  test('one input with optional --cluster / --cluster=', () => {
    expect(parseArgs(['x'])).toEqual({ ok: true, input: 'x' });
    expect(parseArgs(['--cluster', 'mainnet', 'x'])).toEqual({ ok: true, input: 'x', cluster: 'mainnet' });
    expect(parseArgs(['x', '--cluster=devnet'])).toEqual({ ok: true, input: 'x', cluster: 'devnet' });
    expect(parseArgs(['x', '--cluster'])).toEqual({ ok: false, reason: '--cluster must be devnet or mainnet' });
    expect(parseArgs(['x', '--verbose'])).toEqual({ ok: false, reason: 'unknown option --verbose' });
  });
});

describe('classifyCliInput (Req 15.8)', () => {
  test('a solana: link is classified as a link, never as base64', async () => {
    const transfer = await classifyCliInput(`solana:${DEMO.safeRecipient}`, noProbeResolver);
    expect(transfer.kind).toBe('scan');
    if (transfer.kind === 'scan') {
      expect(transfer.input.kind).toBe('link');
      if (transfer.input.kind === 'link') expect(transfer.input.link.kind).toBe('transfer-request');
    }

    const request = await classifyCliInput('solana:https://pay.example.test/tx', noProbeResolver);
    expect(request.kind === 'scan' && request.input.kind === 'link' && request.input.link.kind).toBe('transaction-request');

    const action = await classifyCliInput(DEMO_LINKS.drainer, noProbeResolver);
    expect(action.kind === 'scan' && action.input.kind === 'link' && action.input.link.kind).toBe('blink');
  });

  test('base64 without a link prefix is a raw transaction; other text is unrecognized', async () => {
    const base64 = await safeTransaction(SUBJECT);
    expect(await classifyCliInput(base64, noProbeResolver)).toEqual({
      kind: 'scan',
      input: { kind: 'raw-transaction', base64 },
    });
    expect(await classifyCliInput('not a link!', noProbeResolver)).toEqual({ kind: 'unrecognized' });
  });

  test('unrecognized input → exit 2 with usage', async () => {
    const io = captureIo();
    const code = await runCli(['not a link!'], { ...cliOpts(unfunded), io });
    expect(code).toBe(2);
    expect(io.err).toContain(USAGE);
  });
});
