import { aiConfig } from './aiConfig.js';
import { chat, forFeature } from './models.js';
import { DATA_WORDS, GUIDE, guideText, platformCandidate, relevantSections } from './platformGuide.js';
import { isVagueFollowUp, type Turn } from './memory.js';

/**
 * Questions about Lens MLOps itself (the platform, its tabs, navigation, how answers are
 * checked) are answered from the platform guide, not sent to the query engine, which
 * only knows the model data. Everything else goes through the normal pipeline
 * untouched.
 *
 * - With a model (`platform_help` in the deploy config): a cheap word check picks the
 *   candidates, then the model answers from the guide only, or replies DATA_QUESTION
 *   so the question goes to the query engine as usual.
 * - Without a model: a stricter word check, and the best-matching guide sections are
 *   shown as the answer.
 */

export interface PlatformAnswer { text: string; sections: string[]; method: 'ai' | 'guide'; model?: string; ms: number }

const PROMPT = `You are the help desk of Lens MLOps, a Concentrix analytics product for monitoring a fleet of ML models.
Answer the user's question about the platform using ONLY the guide below. Be practical: a short answer, then
bullet points or steps if useful. For "how do I" questions, give the steps from "How to do common things" in the
guide, word for word where possible. Only name tabs, buttons, menus, boxes and features that the guide names;
never add any (for example, there is no search bar for filters and no "Filters tab"). For "what is Lens MLOps" questions,
also list the four tabs in one line each. Use markdown, no headings. If the guide doesn't cover it, say so briefly
and suggest where to look (KPI definitions, Observability, Responsible AI). Never invent features, figures or
facts about Concentrix beyond the guide.
Reply in the language of the question.
If the question is really asking about the model DATA (figures, models, drift, confidence, alerts, incidents, sites,
business units, savings, trends, causes, recommendations) rather than about the platform, reply with exactly: DATA_QUESTION

GUIDE:
`;

/** "You do it", "answer it yourself": the person wanted the answer, not the steps to find it. */
const PUSHBACK = /\b(you do it|do it (yourself|for me)|answer (it |this |that )?(yourself|for me|directly)|(i )?(can'?t|cannot|don'?t want to) do (it|this|that)|just (tell|show|give) me|not the steps|i asked (for|about) the (data|numbers)|show me the (data|numbers|answer))\b/i;

/** A follow-up like "tell me more" right after a platform answer is about the platform too. */
export const followsPlatform = (question: string, history: Turn[]) => {
  const last = history[history.length - 1];
  return Boolean(last?.platform) && isVagueFollowUp(question) && !DATA_WORDS.test(question) && !PUSHBACK.test(question);
};

export function isPlatformCandidate(question: string, history: Turn[] = []): boolean {
  const cfg = aiConfig.platformHelp;
  if (!cfg) return false;
  return platformCandidate(question, cfg.method !== 'ai') || followsPlatform(question, history);
}

/** `force`: a clicked suggested question about the platform. It is answered from the guide, never handed back to the engine. */
export async function answerPlatform(question: string, history: Turn[] = [], force = false): Promise<PlatformAnswer | null> {
  const cfg = aiConfig.platformHelp;
  if (!cfg || (!force && !isPlatformCandidate(question, history))) return null;
  const t0 = Date.now();
  const follow = followsPlatform(question, history);
  const last = history[history.length - 1];
  // "Tell me more" after a platform answer: the sections that weren't shown yet.
  let sections = relevantSections(question);
  if (follow && last) {
    const more = relevantSections(`${last.q} ${question}`, 6).filter((x) => !last.sections.includes(x.id));
    sections = (more.length ? more : GUIDE.filter((x) => !last.sections.includes(x.id))).slice(0, 2);
  }
  if (cfg.method === 'ai' && cfg.model) {
    const recent = history.slice(-2).map((t) => `Q: ${t.q.slice(0, 300)}\nA: ${t.a.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n');
    try {
      const { text } = await forFeature('platform_help', () => chat(cfg.model!, [
        // A "tell me more" follow-up only gets the parts of the guide not shown yet, so it adds rather than repeats.
        { role: 'system', content: PROMPT + (follow ? sections.map((x) => `## ${x.title}\n${x.text}`).join('\n\n') : guideText()) },
        // A follow-up gets the earlier question only (not the answer, which a small model would just repeat).
        { role: 'user', content: follow && last
          ? `The user first asked: "${last.q.slice(0, 300)}" and has had that answer. Now they say: "${question.slice(0, 500)}".
Tell them more, using the guide above, which has information they have not seen yet. Start directly with the new information.`
          : (recent ? `EARLIER IN THIS CONVERSATION:\n${recent}\n\n` : '') + `QUESTION: ${question.slice(0, 1000)}` },
      ], { maxTokens: 600, timeoutMs: 20000 }));
      const reply = text.trim();
      if ((!reply || /^DATA_QUESTION\b/.test(reply)) && !force) return null;   // goes to the query engine as usual
      if (reply && !/^DATA_QUESTION\b/.test(reply)) return { text: reply.replace(/DATA_QUESTION/g, '').trim(), sections: sections.map((s) => s.id), method: 'ai', model: cfg.model, ms: Date.now() - t0 };
    } catch (err) {
      console.warn('[platform help] model failed, using the guide:', err instanceof Error ? err.message : err);
      // A strong platform question (or a follow-up to one) still gets the guide; a loose one goes to the engine.
      if (!platformCandidate(question, true) && !follow && !force) return null;
    }
  }
  const text = sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n');
  return { text, sections: sections.map((s) => s.id), method: 'guide', ms: Date.now() - t0 };
}
