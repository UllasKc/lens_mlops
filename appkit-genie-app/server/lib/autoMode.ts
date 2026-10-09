/**
 * The word rule for Quick answer vs Deep analysis: the router's fallback (router.ts) when
 * its model is off, slow or unreadable, so a question is never held up.
 */

export type Mode = 'chat' | 'agent';
export interface RouteResult {
  mode: Mode;
  method: 'ai' | 'rules';
  reason: string;
  model?: string;
  ms?: number;
  fallback?: string;
}

const DEEP = /\b(why|how (can|could|should|do|would) we|what should|recommend|strateg(y|ies)|improve|root cause|driving|compare|comparison|analy[sz]e|analysis|investigat|prioriti[sz]e|plan|explain|briefing|brief|impact|trade-?off|correlat\w*|what (is|are) (causing|behind))\b/;
/** "Which / what / show / list / how many …" questions that only look something up. */
const LOOKUP_START = /^\s*(which|what (is|are|was|were)|show|list|give me|how (many|much)|top \d+|count)\b/;

/** The word rule: reasoning words or long multi-part questions go deep; plain lookups stay quick. */
export function rulesMode(question: string): RouteResult {
  const t = String(question).toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 22) return { mode: 'agent', method: 'rules', reason: 'long, multi-part question' };
  const m = t.match(DEEP);
  if (m) return { mode: 'agent', method: 'rules', reason: `asks for reasoning ("${m[0]}")` };
  // "happening" / "spike" / "concentrated" only mean analysis when the question isn't a plain lookup.
  if (!LOOKUP_START.test(t) && /\b(happening|spikes?|concentrat\w*)\b/.test(t)) return { mode: 'agent', method: 'rules', reason: 'asks what happened or where it concentrates' };
  return { mode: 'chat', method: 'rules', reason: 'a direct lookup' };
}
