/**
 * The only module that reads environment variables (Req 17.1).
 * Bun loads `.env` automatically; a real process variable wins over `.env`.
 */
import { address, isAddress, type Address } from '@solana/kit';
import type { Cluster } from './scan/types.ts';

export interface Config {
  /** '' when unset. Checked in src/index.ts, not here, so the CLI runs without it. */
  discordToken: string;
  aiApiKey: string;
  heliusApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  aiFallbackModel: string;
  defaultCluster: Cluster;
  placeholderAccount: Address;
  rpcUrls: Record<Cluster, string>;
  extraKnownPrograms: readonly Address[];
}

export type ConfigError = { variable: string; reason: string };

/**
 * Off-curve PDA of the System Program with seed "solana-scanner-placeholder"
 * (bump 254). No private key can exist for it.
 */
export const DEFAULT_PLACEHOLDER_ACCOUNT = 'Hzhu1o57ZuQaPJdHMqbG2aKWHcuJNWARvQMzydsFWKK7';

export const DEFAULTS = {
  AI_BASE_URL: 'https://api.vultrinference.com/v1',
  AI_MODEL: 'minimax-m3.1-flash',
  AI_FALLBACK_MODEL: 'mimo-v2.6-flash',
  SCAN_DEFAULT_CLUSTER: 'mainnet',
  SCAN_PLACEHOLDER_ACCOUNT: DEFAULT_PLACEHOLDER_ACCOUNT,
  SOLANA_RPC_URL_MAINNET: 'https://api.mainnet-beta.solana.com',
  SOLANA_RPC_URL_DEVNET: 'https://api.devnet.solana.com',
} as const;

/** Every variable the bot reads, in `.env.example` order. */
export const CONFIG_VARIABLES = [
  'DISCORD_TOKEN',
  'AI_API_KEY',
  'HELIUS_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_FALLBACK_MODEL',
  'SCAN_DEFAULT_CLUSTER',
  'SCAN_PLACEHOLDER_ACCOUNT',
  'SOLANA_RPC_URL_MAINNET',
  'SOLANA_RPC_URL_DEVNET',
  'SCAN_EXTRA_KNOWN_PROGRAMS',
] as const;

const read = (env: Record<string, string | undefined>, name: string): string => (env[name] ?? '').trim();

const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Pure: trims values, treats whitespace-only as empty, applies defaults, validates (Req 17.1, 17.7). */
export function parseConfig(env: Record<string, string | undefined>): { config: Config } | { errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  const withDefault = (name: keyof typeof DEFAULTS): string => read(env, name) || DEFAULTS[name];

  const clusterRaw = withDefault('SCAN_DEFAULT_CLUSTER');
  if (clusterRaw !== 'mainnet' && clusterRaw !== 'devnet') {
    errors.push({ variable: 'SCAN_DEFAULT_CLUSTER', reason: 'must be "mainnet" or "devnet"' });
  }

  const placeholderRaw = withDefault('SCAN_PLACEHOLDER_ACCOUNT');
  if (!isAddress(placeholderRaw)) {
    errors.push({ variable: 'SCAN_PLACEHOLDER_ACCOUNT', reason: 'must be a base58 32-byte public key' });
  }

  const rpcMainnet = withDefault('SOLANA_RPC_URL_MAINNET');
  const rpcDevnet = withDefault('SOLANA_RPC_URL_DEVNET');
  if (!isHttpUrl(rpcMainnet)) {
    errors.push({ variable: 'SOLANA_RPC_URL_MAINNET', reason: 'must be an absolute http or https URL' });
  }
  if (!isHttpUrl(rpcDevnet)) {
    errors.push({ variable: 'SOLANA_RPC_URL_DEVNET', reason: 'must be an absolute http or https URL' });
  }

  const extras = read(env, 'SCAN_EXTRA_KNOWN_PROGRAMS')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (extras.some((s) => !isAddress(s))) {
    errors.push({ variable: 'SCAN_EXTRA_KNOWN_PROGRAMS', reason: 'every entry must be a base58 32-byte public key' });
  }

  if (errors.length > 0) return { errors };

  return {
    config: {
      discordToken: read(env, 'DISCORD_TOKEN'),
      aiApiKey: read(env, 'AI_API_KEY'),
      heliusApiKey: read(env, 'HELIUS_API_KEY'),
      aiBaseUrl: withDefault('AI_BASE_URL').replace(/\/+$/, ''),
      aiModel: withDefault('AI_MODEL'),
      aiFallbackModel: read(env, 'AI_FALLBACK_MODEL') || DEFAULTS.AI_FALLBACK_MODEL,
      defaultCluster: clusterRaw as Cluster,
      placeholderAccount: address(placeholderRaw),
      rpcUrls: { mainnet: rpcMainnet, devnet: rpcDevnet },
      extraKnownPrograms: extras.map((s) => address(s)),
    },
  };
}

/** Reads the environment once. On invalid values, names each variable on stderr and exits non-zero. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = parseConfig(env);
  if ('errors' in parsed) {
    for (const e of parsed.errors) process.stderr.write(`Invalid configuration: ${e.variable} ${e.reason}\n`);
    process.exit(1);
  }
  return parsed.config;
}
