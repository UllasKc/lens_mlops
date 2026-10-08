import { chat, forFeature } from './models.js';

/** Optional: a chat model serving endpoint (bound to the app as a resource). */
const TITLE_ENDPOINT = process.env.LENS_TITLE_ENDPOINT ?? '';

/** Deterministic fallback: the question itself, tidied and shortened. */
export function fallbackTitle(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  const short = q.length > 48 ? q.slice(0, 48).replace(/\s+\S*$/, '') + '…' : q;
  return short.charAt(0).toUpperCase() + short.slice(1) || 'New conversation';
}

/** Neutral names for sessions whose first question a guardrail blocked or had personal details removed from. */
export const GUARDED_TITLES = { blocked: '⚠ Blocked question', redacted: '⚠ Personal details removed' } as const;
export const isGuardedTitle = (t: string | null | undefined) => Boolean(t && t.startsWith('⚠'));

/** A ChatGPT-style 3–6 word session name for the first question. Never throws. */
export async function generateTitle(question: string): Promise<string> {
  if (!TITLE_ENDPOINT) return fallbackTitle(question);
  try {
    const { text: raw } = await forFeature('title', () => chat(TITLE_ENDPOINT, [
      {
        role: 'system',
        content:
          'You name chat sessions for an assistant that monitors a fleet of ML models. Reply with a 3 to 6 word title in Title Case ' +
          'that summarises the user\'s question, in the language of the question. No quotes, no trailing punctuation, nothing else.',
      },
      { role: 'user', content: question.slice(0, 500) },
    ], { maxTokens: 20, timeoutMs: 8000 }));
    const text = raw.split('\n')[0].replace(/^["'*#\s]+|["'*.\s]+$/g, '').trim();
    return text && text.length <= 60 ? text : fallbackTitle(question);
  } catch (err) {
    console.warn('Session title generation failed, using fallback:', err instanceof Error ? err.message : err);
    return fallbackTitle(question);
  }
}
