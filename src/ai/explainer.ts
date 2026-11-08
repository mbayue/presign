/**
 * AI_Explainer (Req 10; Property 31). Asks an OpenAI-compatible endpoint for a
 * 1–2 sentence summary. The result is display-only: callers attach it after the
 * Verdict is computed and never feed it back to the Risk_Engine.
 *
 * Never throws and never logs prompts, responses or the key.
 */
import { postprocess } from './postprocess.ts';
import { buildMessages, type AiContext, type ChatMessage } from './prompt.ts';

export type { AiContext } from './prompt.ts';

export interface AiDeps {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  fetch?: typeof fetch;
  /** One budget for the primary and the fallback attempt together. */
  timeoutMs?: number;
}

export const DEFAULT_AI_TIMEOUT_MS = 8_000;
export const AI_MAX_TOKENS = 160;
export const AI_TEMPERATURE = 0.2;

class Aborted extends Error {}

/** Settles with the promise, or rejects as soon as `signal` aborts (even if the fetch ignores it). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function readContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

/** One attempt. Returns the cleaned summary, or null on any failure. Rethrows only `Aborted`. */
async function attempt(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const response = await abortable(
      doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: AI_MAX_TOKENS,
          temperature: AI_TEMPERATURE,
          reasoning_effort: 'minimal',
        }),
        signal,
      }),
      signal,
    );
    if (!response.ok) {
      // Release the connection; the body is not needed.
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const payload: unknown = await abortable(response.json() as Promise<unknown>, signal);
    const content = readContent(payload);
    if (content === null) return null;
    const summary = postprocess(content);
    return summary === '' ? null : summary;
  } catch (e) {
    if (e instanceof Aborted || signal.aborted) throw new Aborted();
    return null;
  }
}

export async function explain(ctx: AiContext, deps: AiDeps): Promise<string | null> {
  if (deps.apiKey === '') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS);
  try {
    const doFetch = deps.fetch ?? globalThis.fetch;
    const url = `${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const messages = buildMessages(ctx);

    const primary = await attempt(doFetch, url, deps.apiKey, deps.model, messages, controller.signal);
    if (primary !== null) return primary;
    if (deps.fallbackModel === '') return null;
    return await attempt(doFetch, url, deps.apiKey, deps.fallbackModel, messages, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
