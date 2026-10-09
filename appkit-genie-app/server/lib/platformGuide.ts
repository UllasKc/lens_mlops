/**
 * What Lens MLOps knows about itself. Questions about the platform ("What is Lens MLOps?",
 * "How do I filter by site?", "What does Observability show?") are answered from this
 * guide instead of the model data. Keep it in step with the UI: it is the only source the
 * platform answers may use. No data figures here (those come from the query engine), so
 * the guide never goes stale when the data is reloaded.
 */

export interface GuideSection { id: string; title: string; keywords: string[]; text: string }

export const GUIDE: GuideSection[] = [
  {
    id: 'about', title: 'What Lens MLOps is',
    keywords: ['lens', 'mlops', 'lens mlops', 'concentrix', 'what is', 'who built', 'who made', 'platform', 'about', 'purpose', 'what are you', 'who are you', 'what can you do'],
    text: `**Lens MLOps** is a Concentrix decision-intelligence product, built by the **Concentrix Data & Analytics Practice**. It shows leaders and engineers how a fleet of production ML models is doing and what it is worth, with every figure traceable to its source.
It covers model health (confidence, drift, accuracy against actual values, latency), anomaly alerts and incidents, false alarms, and the business value attributed to the models (downtime avoided, cost savings, yield).
It has four tabs: **Command Center** (how the fleet is doing, in about a minute), **Explorer** (why, with filters and drill-downs), **Assistant** (ask questions in plain language) and **Observability** (how every answer was made, its quality, cost and safety).
The answers come from the **Lens Intelligence Engine**, which turns a question into SQL over certified, governed views of the model data, runs it and explains the result. Every figure on the dashboards comes from those same views; no AI computes them.`,
  },
  {
    id: 'command-center', title: 'Command Center tab',
    keywords: ['command center', 'command centre', 'home', 'dashboard', 'first page', 'overview', 'health', 'kpi', 'metrics', 'summary', 'executive summary', 'issues', 'action', 'actions', 'queues', 'value', 'incidents'],
    text: `The **Command Center** is the one-minute view of the model fleet, told as one story in five chapters:
1. **Is the model fleet healthy?** The verdict, the healthy / low-confidence / drifting split, and four headline figures (models monitored, predictions scored and verified, alerts confirmed, estimated value).
2. **Where does the fleet need attention?** Health cards (healthy, drifting, low confidence, business-critical models needing attention, ground-truth coverage; **Show 5 more metrics** adds confidence, latency, alert precision and error), then health by business unit and by asset type.
3. **What is degrading?** The issues ranked by severity: drift, low confidence, false alarms, accuracy and unanswered alerts.
4. **What should we do this week?** Four work queues (review drift and plan retraining, investigate low confidence, tune alert thresholds, close unanswered alerts) and the list of every model with a next step.
5. **What value have the models delivered?** The incidents the models caught, savings by business unit and by criticality, and yield for reactor and furnace models.
An **executive summary** under the banner gives the bottom line and one line per chapter. **View models** on any card lists the models behind the figure, with **Export CSV**; **View alerts** on an incident lists its alerts minute by minute. **KPI definitions** explains every figure. Every panel has an **Ask Lens** button; hover over it to see the exact question it will ask.`,
  },
  {
    id: 'explorer', title: 'Explorer tab',
    keywords: ['explorer', 'filter', 'filters', 'drill', 'drill down', 'slice', 'slicer', 'why', 'site', 'business unit', 'bu', 'asset', 'team', 'criticality', 'date', 'dates', 'day', 'export', 'csv', 'download data', 'models list', 'records', 'segment'],
    text: `The **Explorer** answers "why": it slices the same governed data by any combination of filters.
- **Filters:** business unit, site, asset type, model type, criticality, owner team and health status, plus a day range. Active filters show as chips; click a chip's × to remove it, or **Reset filters**.
- **Headline tiles** show the filtered figures compared with the whole fleet.
- **Analytical exploration workspace:** pick a dimension and a measure to compare, as bars or a table. **Click any bar to filter the whole page to it** (drill-down).
- **Business unit × asset type** grid: where the models needing attention sit. **Day by day:** confidence, drift, alerts and savings for each day.
- **Model records:** every model in the current view, with search, sort and paging. **Export CSV** downloads them.
- **Ask Lens about this view** asks why the filtered slice differs from the fleet; every panel's question carries the active filters.
Model health (healthy, drifting, low confidence) is judged on the latest day; the day range changes the other figures. With no filters, every Explorer figure reconciles exactly to the Command Center.`,
  },
  {
    id: 'assistant', title: 'Assistant tab',
    keywords: ['assistant', 'chat', 'ask', 'question', 'conversation', 'history', 'new chat', 'search chats', 'sidebar', 'prompts', 'quick start', 'library', 'suggested', 'follow-up', 'pdf', 'download', 'voice', 'microphone', 'rename', 'delete', 'notification'],
    text: `The **Assistant** answers questions about the model data in plain language, with charts.
- **Modes** (menu at the top left): **Quick answer** (one query, about 20 seconds), **Deep analysis** (investigates step by step with several queries and charts, 1–3 minutes), or **Auto**, which picks one for each question.
- **Quick start prompts and the question library** (lightbulb icon, top right): one-click analyses and questions grouped by Business leader, Reliability engineer, Operator and Health & risk.
- **Conversations** are saved per person. The sidebar has **New chat**, **Search** and the list of chats; when it is collapsed, the same three icons stay on the left. Hover a chat to rename or delete it.
- **Under each answer:** copy, 👍 / 👎 (👎 asks what was wrong and goes to a review queue), regenerate, and **Details**: the quality score, the data sources, the SQL that ran and how long each step took, with a link to inspect it in Observability. Follow-up questions appear after the answer.
- **Download PDF** (icon at the top right) saves the conversation, charts included.
- Answers to common questions may come from the **answer cache** (instant); **Refresh** asks the engine again.
- If you switch tabs while a deep analysis runs, you get a notification when it is ready. Where the browser supports it, the microphone lets you ask by voice.`,
  },
  {
    id: 'howto', title: 'How to do common things (exact steps)',
    keywords: ['how do i', 'how can i', 'how to', 'steps', 'filter', 'site', 'business unit', 'export', 'csv', 'drill', 'pdf', 'download', 'new chat', 'search', 'rename', 'delete', 'mode', 'log out', 'kpi definitions', 'sql', 'feedback', 'evals', 'run evals'],
    text: `- **Filter the Explorer (for example by site):** open the **Explorer** tab. At the top of the page are dropdown boxes, one per filter (Business unit, Site, Asset type, Model type, Criticality, Owner team, Health). Choose a value in the **Site** dropdown; the whole page updates. The filter appears as a chip; click its × to remove it, or **Reset filters** (top right of the Explorer) to clear all.
- **Filter by day:** in the Explorer, use the **Day from / to** boxes under the dropdowns.
- **Drill down:** in the Explorer's analytical exploration workspace, choose a **Dimension** and a **Measure**, then click any bar.
- **See the models behind a figure:** click **View models** on any Command Center card or **View** in the Explorer; **Export CSV** in that window downloads them.
- **Export models:** in the Explorer, click **Export CSV** (top right); it downloads the model records for the current filters.
- **See the SQL and quality of an answer:** in the Assistant, click **Details** under the answer.
- **Choose Quick answer, Deep analysis or Auto:** in the Assistant, click the mode name at the top left (it shows "Auto" by default) and pick one.
- **Start, find, rename or delete a chat:** in the Assistant's left sidebar, **New chat**, **Search**, or hover a chat in the list for rename and delete.
- **Download a conversation:** in the Assistant, the download icon at the top right saves it as a PDF.
- **See how a figure is calculated:** on the Command Center, click **KPI definitions**.
- **Log out:** click the round letter at the top right, then **Log out**.
- **Run the evaluation suite:** Observability → **6. Evaluations** → choose the categories → **Run evals**.`,
  },
  {
    id: 'modes', title: 'Quick answer, Deep analysis and Auto',
    keywords: ['quick answer', 'deep analysis', 'auto', 'auto mode', 'mode', 'agent', 'how long', 'slow', 'fast'],
    text: `**Quick answer** runs one query and answers in about 20 seconds: best for "what is / which / show me" questions.
**Deep analysis** plans and runs several queries, builds charts and explains the reasons and actions: best for "why" and "what should we do" questions. It takes 1–3 minutes.
**Auto** (the default) chooses for each question: depending on the deployment, a small AI model or a word rule decides, and the reason is recorded in Observability. Prompts and Ask Lens buttons that name a mode always use it.`,
  },
  {
    id: 'observability', title: 'Observability tab',
    keywords: ['observability', 'monitoring', 'trace', 'traces', 'audit', 'quality', 'faithfulness', 'groundedness', 'latency', 'performance', 'security', 'guardrail', 'guardrails', 'evals', 'evaluation', 'evaluations', 'responsible ai', 'cost', 'tokens', 'feedback review', 'cache'],
    text: `**Observability** shows how every answer the Assistant gave was made, from live logs, for a chosen period (24 hours, 7 days, 30 days, all time). It monitors the Assistant itself, not the ML models in the data (those are on the Command Center). A headline row shows groundedness, numeric reconciliation, average latency and the personal-data guardrail. Seven areas:
1. **Pipeline traces:** every question with its path (ask, secure, cache, plan, retrieve, verify, synthesize, deliver, log), timings and SQL; filter by passed, blocked or failed, by user, or search.
2. **Answer quality & faithfulness:** quality per day, low-confidence answers, reasons for 👎, and the **feedback review** queue (mark fixed, dismiss, or add to the evaluation suite).
3. **Performance & latency:** questions and answer time per day, time per stage, the answer cache, AI usage and cost, and usage by user.
4. **Data & model drift:** data and semantic-model versions, the AI models in use, the quick/deep mix and evaluation pass rates.
5. **Security & guardrails:** checks that fired and recent guardrail events.
6. **Evaluations:** run the test suite (ground-truth accuracy, red-team guardrail tests, policy checks) and see results by run.
7. **Responsible AI:** purpose, the AI models and when they run, the data used, protections, how quality is measured, data handling and known limits.`,
  },
  {
    id: 'trust', title: 'How answers are checked and kept safe',
    keywords: ['trust', 'accurate', 'accuracy', 'hallucinate', 'made up', 'verify', 'quality score', 'faithfulness', 'pii', 'personal data', 'privacy', 'secure', 'security', 'safe', 'governed', 'certified', 'sql', 'source'],
    text: `- **Governed data only:** the engine reads certified gold views of the model data, read-only, through the app's own service identity. The data describes models, assets and sites; it holds no personal information.
- **Guardrails** check each question (personal data is masked, abusive language and prompt-injection attempts are blocked, off-topic questions are flagged) and each answer (personal data, profanity, and claims the data can't support: forecasts, the effect of retraining, ROI, probabilities).
- **Quality check:** after an answer, every figure is looked up in the query results, and a judge model scores faithfulness, relevance, completeness and safety. Answers that score low carry a visible warning. **Details** under each answer shows the score, the sources and the exact SQL.
- **People in the loop:** 👎 feedback goes to a review queue and can become a permanent test case.
- Questions and answers are not used to train any model.`,
  },
  {
    id: 'navigation', title: 'Navigation and account',
    keywords: ['navigate', 'navigation', 'tabs', 'menu', 'account', 'profile', 'log out', 'logout', 'sign out', 'sign in', 'user', 'name', 'email', 'where', 'find', 'open', 'go to', 'mobile', 'phone'],
    text: `- The **top bar** has the four tabs (Command Center, Explorer, Assistant, Observability).
- The **round letter at the top right** is your account: click it to see your full name, email and **Log out**. Log out ends the Lens MLOps session in this browser; your organisation (Databricks) sign-in stays active until you sign out of the workspace or close the browser.
- Any **Ask Lens** button on the Command Center or Explorer opens the Assistant with that question; **Drill into the data** on the Command Center opens the Explorer.
- The pages also work on tablets and phones.`,
  },
  {
    id: 'data', title: 'What data Lens MLOps uses',
    keywords: ['data', 'window', 'as of', 'date', 'refresh', 'updated', 'models', 'predictions', 'ground truth', 'actuals', 'currency', 'dollar', 'tables', 'views', 'definitions', 'kpi definitions', 'thresholds'],
    text: `- **Coverage:** 100 production ML models across business units, sites and asset types, with a prediction every minute over a three-day monitoring window, and hourly business outcomes. "Now" means the end of the window. Amounts are in US dollars.
- **Ground truth:** about 30% of predictions have no actual value yet (it arrives later); that is expected, and accuracy uses only the predictions that have one.
- **Definitions** of every figure are in **KPI definitions** on the Command Center (for example: a low-confidence prediction is below 60% confidence; a model is drifting when its average drift score on the latest day is 0.30 or more). The thresholds are stored with the data, with the reason for each.
- The dashboards and the Assistant use the same certified views, so their figures agree.`,
  },
  {
    id: 'limits', title: 'Known limits',
    keywords: ['limit', 'limits', 'limitation', 'cannot', "can't", 'forecast', 'predict', 'wrong', 'mistake', 'not able', 'roi', 'retrain', 'retraining', 'cause'],
    text: `- The data covers three days; Lens MLOps does not forecast drift, alerts or savings beyond it.
- It does not say what retraining or tuning would achieve: no model was retrained in the window, so there is nothing to compare. It recommends reviews, not outcomes.
- Savings are the estimates recorded in the data. There is no model cost data, so it reports savings, not ROI. There are no targets in the data.
- Drift and alerts are recorded, not their causes; finding a cause needs engineering investigation.
- AI answers can be wrong: check the quality score and the SQL under **Details** before acting on an answer.`,
  },
];

/**
 * Cheap first filter: does the question mention the platform at all? Only these go on
 * to the platform step, so data questions never pay for it. `strict` is used when no
 * model is available to confirm, and leaves out the words data questions also use.
 */
const STRONG = /\b(lens mlops|concentrix|this (app|application|platform|tool|site|dashboard|assistant)|what can you (do|answer|help)|who (built|made|created|are you)|what are you|command cent(er|re)|explorer tab|observability|kpi (dictionary|definitions)|quick answer|deep analysis|auto mode|responsible ai|log ?out|sign ?out|how (do|can) i (use|ask|filter|export|download|switch|change|log|sign|search|delete|rename|start|open|find the|go to|navigate)|which tab|what tabs|the tabs|navigate|navigation)\b/i;
const LOOSE = /\b(lens|explorer|assistant|tab|tabs|page|evals?|evaluations?|guardrails?|faithfulness|groundedness|trace|traces|cache|pdf|feature|features|help|how does (this|it) work|where (do|can|is))\b/i;
/** Words that make a question about the model data, not the platform ("and for Houston 1?"). */
export const DATA_WORDS = /\b(models?|mdl_?\d*|predictions?|drift(ing)?|confidence|accura(te|cy)|errors?|latency|alerts?|anomal(y|ies)|incidents?|false|positives?|savings?|value|downtime|yield|sites?|business units?|bus?|assets?|compressors?|pumps?|reactors?|furnaces?|turbines?|hvac|exchangers?|versions?|owners?|teams?|criticality|critical|rates?|day|days|week|hour|hours|lowest|highest|top|worst|best|figures?|numbers?|houston|phoenix|chicago|seattle|austin|new york)\b|\$|\d/i;
/** Things on screen: a data word next to one of these ("where is the site filter?") is still a platform question. */
const UI_WORDS = /\b(tabs?|pages?|buttons?|filters?|drop-?downs?|menus?|click|screen|export|download|explorer|assistant|observability|dashboard|chart type|settings)\b/i;
export function platformCandidate(question: string, strict: boolean): boolean {
  if (STRONG.test(question)) return true;
  if (strict || !LOOSE.test(question)) return false;
  // A loose word alone ("where is the drift concentrated?") doesn't make a data question a platform one:
  // a small model asked to confirm can answer it from the guide anyway, with made-up steps.
  return !DATA_WORDS.test(question) || UI_WORDS.test(question);
}

/** The guide sections that best match a question (keyword overlap), for the model or for a no-model answer. */
export function relevantSections(question: string, max = 3): GuideSection[] {
  const q = question.toLowerCase();
  const has = (k: string) => new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(q);   // whole words: "bu" must not match "built"
  const scored = GUIDE.map((s) => ({ s, score: s.keywords.reduce((a, k) => a + (has(k) ? (k.includes(' ') ? 2 : 1) : 0), 0) }));
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.filter((x) => x.score > 0).slice(0, max).map((x) => x.s);
  return hits.length ? hits : [GUIDE[0]];
}

export const guideText = () => GUIDE.map((s) => `## ${s.title}\n${s.text}`).join('\n\n');
