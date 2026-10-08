/**
 * The suggested questions: the six tiles on an empty chat, plus four more in
 * the side panel (five per mode). One list, served to the front end and used
 * to pre-warm the answer cache. The quick questions match certified examples in
 * the Genie space (deploy/genie/space.py), so they get consistent answers.
 */
export interface Suggestion {
  mode: 'chat' | 'agent';
  label: string;
  q: string;
}

export const STARTERS: Suggestion[] = [
  { mode: 'chat', label: 'How healthy is the model fleet?', q: 'How healthy is our model fleet right now?' },
  { mode: 'chat', label: 'Models drifting this week', q: 'Which models are showing drift this week?' },
  { mode: 'chat', label: 'Total cost savings this week', q: 'What is total cost savings this week?' },
  { mode: 'agent', label: "What's happening with MDL_061? Explain the spike", q: "What's happening with MDL_061? Explain the spike." },
  { mode: 'agent', label: 'Which models need action first, and why?', q: 'Which models need action first, and why? Rank them by business risk.' },
  { mode: 'agent', label: 'Daily executive briefing', q: 'Give me a daily executive briefing: top incident, biggest savings, worst-performing model.' },
];

export const MORE_SUGGESTIONS: Suggestion[] = [
  { mode: 'chat', label: 'Models with confidence below 60% right now', q: 'Which models have confidence below 60% right now?' },
  { mode: 'chat', label: 'False positive rate by model version', q: 'Which model version has the highest false positive rate?' },
  { mode: 'agent', label: 'Accuracy of the Furnace models', q: 'Compare predicted vs actual accuracy across all Furnace models' },
  { mode: 'agent', label: 'Where the value came from, and how concentrated it is', q: 'Which business units and incidents delivered the value, and how concentrated is it?' },
];

export const ALL_SUGGESTIONS: Suggestion[] = [...STARTERS, ...MORE_SUGGESTIONS];

/**
 * Quick-start prompts: one-click analyses shown on the Assistant's welcome screen
 * and at the top of the prompts panel (icon, category, title, one-line description).
 */
export interface QuickStart { icon: string; category: string; title: string; desc: string; q: string; mode: 'chat' | 'agent' }

export const QUICK_START: QuickStart[] = [
  { icon: 'alert', category: 'Health', title: 'Models needing action', desc: 'Drift, low confidence and false alarms, ranked', mode: 'agent',
    q: 'Which models need action first, and why? Rank them by business risk.' },
  { icon: 'gap', category: 'Drift', title: 'Drift this week', desc: 'Which models drifted, how fast, and where', mode: 'agent',
    q: 'Which models are showing drift this week, how fast is it rising, and which sites and business units are affected?' },
  { icon: 'promise', category: 'Incidents', title: 'The biggest incident', desc: 'What happened with MDL_061, hour by hour', mode: 'agent',
    q: "What's happening with MDL_061? Explain the spike." },
  { icon: 'cash', category: 'Value', title: 'Where the value came from', desc: 'Savings and downtime avoided, by unit and incident', mode: 'agent',
    q: 'Which business units and incidents delivered the value, and how concentrated is it?' },
  { icon: 'shield', category: 'Alert quality', title: 'Are we crying wolf?', desc: 'False alarms by model and version', mode: 'agent',
    q: 'How many of our alerts are false alarms, which models and versions raise the most, and what should we review?' },
  { icon: 'brief', category: 'Executive', title: 'Daily executive briefing', desc: 'Top incident, biggest savings, worst model', mode: 'agent',
    q: 'Give me a daily executive briefing: top incident, biggest savings, worst-performing model.' },
];

/** The categorized question library, by persona and what they are trying to do. */
export const LIBRARY: Array<{ category: string; items: Array<{ q: string; tag: string; mode: 'chat' | 'agent' }> }> = [
  { category: 'Business leader', items: [
    { q: 'What can you help me with?', tag: 'capabilities', mode: 'chat' },
    { q: 'What is total cost savings this week?', tag: 'value', mode: 'chat' },
    { q: 'Which business unit delivered the most value in the last 24 hours?', tag: 'business units', mode: 'chat' },
    { q: "What's the ROI of our High-criticality models vs Low-criticality ones?", tag: 'criticality', mode: 'agent' },
    { q: 'Give me a daily executive briefing: top incident, biggest savings, worst-performing model.', tag: 'brief', mode: 'agent' },
  ] },
  { category: 'Reliability engineer', items: [
    { q: 'Which models are showing drift this week?', tag: 'drift', mode: 'chat' },
    { q: 'Compare predicted vs actual accuracy across all Furnace models', tag: 'accuracy', mode: 'chat' },
    { q: 'Which model version has the highest false positive rate?', tag: 'false positives', mode: 'chat' },
    { q: 'Are there correlated anomalies between compressors and reactors at the same site?', tag: 'correlation', mode: 'agent' },
  ] },
  { category: 'Operator', items: [
    { q: 'Which models are flagging anomalies in the last hour?', tag: 'live alerts', mode: 'chat' },
    { q: 'Which models have confidence below 60% right now?', tag: 'confidence', mode: 'chat' },
    { q: 'Show me the status of all compressors at SITE_HOU_01', tag: 'site status', mode: 'chat' },
    { q: "What's happening with MDL_061? Explain the spike.", tag: 'incident', mode: 'agent' },
  ] },
  { category: 'Health & risk', items: [
    { q: 'How healthy is our model fleet right now?', tag: 'fleet health', mode: 'chat' },
    { q: 'Which models need action first, and why? Rank them by business risk.', tag: 'priorities', mode: 'agent' },
    { q: 'How has the fleet changed day by day?', tag: 'trend', mode: 'chat' },
    { q: 'How much downtime did we avoid at the Houston sites?', tag: 'downtime', mode: 'chat' },
  ] },
];
