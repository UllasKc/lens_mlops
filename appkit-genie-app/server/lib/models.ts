import { AsyncLocalStorage } from 'node:async_hooks';
import { getExecutionContext } from '@databricks/appkit';

/**
 * Calls to Databricks model serving endpoints (Foundation Model APIs), as the
 * app's service principal. deploy.py grants it CAN_QUERY on each configured
 * endpoint, so no keys are involved.
 */

// --- token accounting ------------------------------------------------------------
// Every model call made while handling one question (or one eval run) adds its
// token counts to that request's ledger, by feature, for Monitoring's cost view.

export interface TokenEntry { model: string; calls: number; input: number; output: number }
export type TokenLedger = Record<string, TokenEntry>; // feature -> totals

const ledgerStore = new AsyncLocalStorage<{ ledger: TokenLedger; feature: string }>();

/** Runs fn with a ledger collecting the token usage of every model call inside it. */
export function withTokenLedger<T>(ledger: TokenLedger, fn: () => T): T {
  return ledgerStore.run({ ledger, feature: 'other' }, fn);
}

/** Labels the model calls made inside fn (e.g. 'judge'); they still land in the surrounding ledger. */
export function forFeature<T>(feature: string, fn: () => Promise<T>): Promise<T> {
  const cur = ledgerStore.getStore();
  return cur ? ledgerStore.run({ ledger: cur.ledger, feature }, fn) : fn();
}

function record(model: string, usage: Record<string, number> | null | undefined) {
  const cur = ledgerStore.getStore();
  if (!cur || !usage) return;
  const e = (cur.ledger[cur.feature] ??= { model, calls: 0, input: 0, output: 0 });
  e.model = model;
  e.calls += 1;
  e.input += Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  e.output += Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
}

/** "databricks-gpt-oss-20b" -> "GPT-OSS 20B": the model's own name, as shown in the app. */
export function modelLabel(endpoint: string | null | undefined): string {
  if (!endpoint) return '';
  const known: Record<string, string> = {
    'databricks-gte-large-en': 'GTE Large (English)',
    'databricks-gpt-oss-20b': 'GPT-OSS 20B',
    'databricks-gpt-oss-120b': 'GPT-OSS 120B',
    'databricks-meta-llama-3-1-8b-instruct': 'Llama 3.1 8B Instruct',
    'databricks-meta-llama-3-3-70b-instruct': 'Llama 3.3 70B Instruct',
    'databricks-bge-large-en': 'BGE Large (English)',
  };
  if (known[endpoint]) return known[endpoint];
  return endpoint.replace(/^databricks-/, '').split('-')
    .map((w) => (/^\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

async function invoke(endpoint: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const client = getExecutionContext().client;
  return (await Promise.race([
    client.apiClient.request({
      path: `/serving-endpoints/${endpoint}/invocations`,
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      raw: false,
      payload,
    } as never),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${endpoint} timed out after ${timeoutMs} ms`)), timeoutMs)),
  ])) as Record<string, unknown>;
}

/** One embedding vector per input text. */
export async function embed(endpoint: string, texts: string[], timeoutMs = 8000): Promise<number[][]> {
  const res = await invoke(endpoint, { input: texts }, timeoutMs);
  record(endpoint, res.usage as Record<string, number> | undefined);
  const data = (res.data ?? []) as Array<{ embedding?: number[]; index?: number }>;
  return data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding ?? []);
}

/** Text of a chat completion. Reasoning models may return content as parts; only text parts are kept. */
export async function chat(
  endpoint: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<{ text: string; usage: Record<string, number> | null }> {
  const res = await invoke(endpoint, { messages, max_tokens: opts.maxTokens ?? 400, temperature: 0 }, opts.timeoutMs ?? 20000);
  record(endpoint, res.usage as Record<string, number> | undefined);
  const msg = (res.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message;
  const content = msg?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p: { type?: string; text?: string }) => (p.type === 'text' ? p.text ?? '' : '')).join('')
      : '';
  return { text, usage: (res.usage as Record<string, number> | undefined) ?? null };
}

/** The first JSON object in a model reply (models sometimes wrap it in prose or ```json fences). */
export function parseJsonObject<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
