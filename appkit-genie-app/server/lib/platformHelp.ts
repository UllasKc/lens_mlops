import { aiConfig } from './aiConfig.js';
import { chat, forFeature } from './models.js';
import { GUIDE, guideText, relevantSections } from './platformGuide.js';
import { isVagueFollowUp, type Turn } from './memory.js';

/**
 * Answers questions about Lens MLOps itself (the platform, its tabs, navigation, how answers
 * are checked) from the platform guide; the query engine only knows the model data.
 * Whether a question comes here is the router's decision (router.ts), not this file's.
 *
 * - With a model (`platform_help` in the deploy config): the model answers from the guide
 *   only. It can still reply DATA_QUESTION, and the question then goes to the query
 *   engine (a safety net under the router), unless the question was a clicked suggestion.
 * - Without a model: the best-matching guide sections are the answer.
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

/**
 * `force`: a clicked suggested question about the platform, answered from the guide and never handed back.
 * Otherwise the guide's model may still say it is a data question (null: the engine answers it).
 */
export async function answerPlatform(question: string, history: Turn[] = [], { force = false, context = '' } = {}): Promise<PlatformAnswer | null> {
  const cfg = aiConfig.platformHelp;
  if (!cfg) return null;
  const t0 = Date.now();
  // "Tell me more" right after a guide answer: the sections not shown yet.
  const last = history[history.length - 1];
  const follow = Boolean(last?.platform) && isVagueFollowUp(question);
  let sections = relevantSections(question);
  if (follow && last) {
    const more = relevantSections(`${last.q} ${question}`, 6).filter((x) => !last.sections.includes(x.id));
    sections = (more.length ? more : GUIDE.filter((x) => !last.sections.includes(x.id))).slice(0, 2);
  }
  if (cfg.method === 'ai' && cfg.model) {
    // The chat so far (summary + newest whole pairs within the guide's budget), from the caller.
    const recent = context;
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
    }
  }
  const text = sections.map((s) => `### ${s.title}\n${s.text}`).join('\n\n');
  return { text, sections: sections.map((s) => s.id), method: 'guide', ms: Date.now() - t0 };
}
