import { Client, GatewayIntentBits } from 'discord.js';
import { log as defaultLog, type Logger } from '../log.ts';

/** Exactly the three intents in Req 17.5. */
export const INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] as const;

export function createClient(): Client {
  return new Client({
    intents: [...INTENTS],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Builds the SIGINT/SIGTERM handler (Req 18.3). Runs once: marks shutdown,
 * destroys the client, closes the store, then exits 0. If that has not
 * finished within `timeoutMs`, or it throws, logs FLUSH_INCOMPLETE and exits 1.
 */
export function createShutdownHandler(deps: {
  markShuttingDown: () => void;
  destroyClient: () => Promise<void> | void;
  closeStore: () => void;
  exit: (code: number) => void;
  timeoutMs?: number;
  log?: Logger;
}): () => Promise<void> {
  const logger = deps.log ?? defaultLog;
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    deps.markShuttingDown();
    logger('info', { code: 'SHUTDOWN' });
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      logger('error', { code: 'FLUSH_INCOMPLETE' });
      deps.exit(1);
    }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    let code = 0;
    try {
      await deps.destroyClient();
      deps.closeStore();
    } catch {
      code = 1;
    }
    clearTimeout(timer);
    if (finished) return;
    finished = true;
    if (code !== 0) logger('error', { code: 'FLUSH_INCOMPLETE' });
    deps.exit(code);
  };
}
