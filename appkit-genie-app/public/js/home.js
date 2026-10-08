// ---------------------------------------------------------------- Command Center
// The one-minute view of the model fleet, told as one story in five chapters: is the fleet
// healthy, where does it need attention, what is degrading, what to do this week, and what
// value the models delivered. The "why" (drill-downs by business unit, site, asset type,
// model type, criticality, team and health, with filters) lives in the Explorer
// (explorer.js). Every figure comes from the certified views (no AI). Each panel has an
// "Ask Lens" link that opens the assistant with the right question.

const hEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CUR = '$';
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

/** $48.3M, $612K, $940. Amounts are estimated savings in US dollars. */
function money(v, digits = 1) {
  const n = num(v);
  if (n === null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return CUR + (n / 1e9).toFixed(digits) + 'B';
  if (a >= 1e6) return CUR + (n / 1e6).toFixed(digits) + 'M';
  if (a >= 1e3) return CUR + (n / 1e3).toFixed(a >= 1e5 ? 0 : digits) + 'K';
  return CUR + Math.round(n).toLocaleString('en-US');
}
const pct = (v, d = 1) => (num(v) === null ? '—' : (num(v) * 100).toFixed(d) + '%');
const count = v => (num(v) === null ? '—' : Math.round(num(v)).toLocaleString('en-US'));
const dec = (v, d = 2) => (num(v) === null ? '—' : num(v).toFixed(d));
const tone = a => (a === null ? 'neutral' : a < 0.88 ? 'bad' : a < 0.95 ? 'warn' : 'good');
/** "2026-10-07 23:59" -> "7 Oct 2026, 23:59": times as recorded in the data, never shifted. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(v, withYear = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v || ''));
  if (!m) return v ? String(v) : '—';
  const d = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${withYear ? ' ' + m[1] : ''}`;
  return m[4] ? `${d}, ${m[4]}:${m[5]}` : d;
}

const ICONS = {
  cash: '<path d="M3 7h18v10H3z"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.8"/>',
  gap: '<path d="M4 18l6-6 4 4 6-8"/><path d="M15 8h5v5"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  slip: '<path d="M4 6l7 7 4-4 5 5"/><path d="M20 10v4h-4"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  spark: '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/>',
};
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const askBtn = (q, mode = 'agent', label = 'Ask Lens') =>
  `<button class="ask-link" data-ask="${hEsc(q)}" data-mode="${mode}" title="${hEsc(q)}">${icon('spark', 'ico-xs')}${label}</button>`;

/** A panel: title, a one-line "so what", its Ask Lens question, and a body. */
function panel(id, title, sub, ask, body) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="panel-head"><div><h3>${hEsc(title)}</h3>${sub ? `<div class="panel-sub">${sub}</div>` : ''}</div>${ask ? askBtn(ask.q, ask.mode) : ''}</div><div class="panel-body">${body}</div>`;
}

/** A labelled horizontal bar; `scale` is the value that fills the track. */
function bar(label, value, scale, shown, t = 'brand', sub = '', marker = null) {
  const w = Math.max(0, Math.min(100, (num(value) / scale) * 100));
  return `<div class="hbar"><div class="hbar-top"><span class="hbar-label">${label}</span><span class="hbar-val">${shown}</span></div>
    <div class="hbar-track">${marker !== null ? `<span class="hbar-marker" style="left:${Math.min(100, (marker / scale) * 100)}%" title="Fleet"></span>` : ''}<span class="hbar-fill t-${t}" style="width:${w.toFixed(1)}%"></span></div>
    ${sub ? `<div class="hbar-sub">${sub}</div>` : ''}</div>`;
}

/** Health split as one bar: healthy, low confidence, drifting. */
const HEALTH_COLORS = { Healthy: '#0E8F80', 'Low confidence': '#D97706', Drifting: '#DC2626' };
function healthStack(healthy, low, drifting) {
  const total = (num(healthy) || 0) + (num(low) || 0) + (num(drifting) || 0);
  if (!total) return '';
  const parts = [['Healthy', healthy], ['Low confidence', low], ['Drifting', drifting]].filter(([, v]) => num(v) > 0);
  return `<div class="stack" role="img" aria-label="${hEsc(parts.map(([l, v]) => `${l}: ${count(v)}`).join(', '))}">${parts.map(([l, v]) =>
    `<span style="width:${(100 * num(v) / total).toFixed(2)}%;background:${HEALTH_COLORS[l]}" title="${l}: ${count(v)} models">${num(v) / total > 0.07 ? count(v) : ''}</span>`).join('')}</div>`;
}
const HEALTH_TAG = { Healthy: 'ok', 'Low confidence': 'warn', Drifting: 'bad' };
const healthTag = h => `<span class="xp-tag ${HEALTH_TAG[h] || 'ok'}">${hEsc(h)}</span>`;
const ACTION_TONE = {
  'Review drift and plan retraining': 'urgent', 'Investigate low confidence': 'care', 'Tune alert threshold': 'digital',
  'Review unanswered alerts': 'dispute', 'No action needed': 'standard',
};
const actionChip = a => `<span class="action-chip a-${ACTION_TONE[a] || 'standard'}">${hEsc(a)}</span>`;
const modelCell = r => `${hEsc(r.model_name)} <span class="muted mono">${hEsc(r.model_id)}</span>`;

function skeletons() {
  document.querySelectorAll('#tab-home .panel').forEach(p => { if (!p.innerHTML.trim()) p.innerHTML = '<div class="skel skel-h"></div><div class="skel"></div><div class="skel"></div><div class="skel short"></div>'; });
  const k = document.getElementById('execKpis');
  if (!k.innerHTML.trim()) k.innerHTML = Array.from({ length: 5 }, () => '<div class="xkpi skel-card"><div class="skel"></div><div class="skel skel-h"></div></div>').join('');
}

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
  return window.userFirstName ? `${part}, ${window.userFirstName}` : part;
}
document.addEventListener('lens:user', () => { const g = document.getElementById('heroGreeting'); if (g) g.textContent = greeting(); });

// ---------------------------------------------------------------- KPI dictionary
// One place that says what every figure means and how it is calculated (the "KPI Dict").
const KPI_DICT = [
  ['Monitoring window', 'The period the figures cover.', 'From the first to the latest prediction in the data (three days, one prediction per model per minute). "Now" and "the latest day" mean the end of the window.'],
  ['Healthy model', 'A model whose outputs can be relied on today.', 'Neither drifting nor low-confidence on the latest day.'],
  ['Drifting model', 'The data the model sees has moved away from what it learned.', 'Average drift score on the latest day of 0.30 or more (business rule drift_alert_threshold).'],
  ['Low-confidence prediction', 'A prediction the model itself is unsure of.', 'Confidence score below 0.60 (business rule low_confidence_score).'],
  ['Low-confidence model', 'A model that is often unsure of itself.', 'At least 20% (1 in 5) of its predictions on the latest day are low-confidence (business rule low_confidence_model_share).'],
  ['Needs attention', 'Models to look at before relying on them.', 'Drifting or low-confidence. Business-critical = criticality High.'],
  ['Verified against actuals', 'How much of the output can be checked yet.', 'Predictions with an actual value ÷ all predictions. About 30% have no actual value yet because it arrives later; that is expected.'],
  ['Error (% of actual)', 'How far predictions are from what happened, comparable across models.', 'For each model: sum of |actual − predicted| ÷ sum of |actual|, over predictions with an actual value. Groups average their models\' values, because models predict in different units.'],
  ['Alert', 'A prediction the model flagged as an anomaly.', 'anomaly_flag = true. Business outcomes count the same alerts per hour as incidents predicted.'],
  ['Incident', 'One event the models caught.', 'Consecutive hours with alerts on the same model.'],
  ['Alert precision / false alarm rate', 'Whether alerts can be trusted.', 'Confirmed incidents ÷ alerts, and false positives ÷ alerts. Tuning is suggested above 25% false alarms (business rule false_positive_rate_threshold).'],
  ['Estimated savings and downtime avoided', 'The value attributed to the models.', 'As recorded in the business outcomes, in US dollars and hours. Estimates, not audited figures; there is no model cost data, so no ROI.'],
  ['Yield improvement', 'Process yield gained.', 'Average percentage points per hour, for reactor and furnace models only (other asset types do not measure yield).'],
  ['Scoring latency', 'How fast models answer.', 'Average milliseconds per prediction; p95 is the time 95% of predictions beat.'],
  ['Action queues', 'Where to put effort this week.', 'Each model sits in the first queue that applies: drifting (review and plan retraining), then low confidence (investigate), then more than 25% false alarms (tune alerts), then alerts recorded as Ignored (close the loop).'],
];
function openKpiDict() {
  document.getElementById('kpiDictBody').innerHTML = `<p class="score-reason">Every figure comes from certified views of the model data; no AI computes them. Thresholds are stored with the data (gold.business_rules_config), with the reason for each.</p>
    <table class="mini kpi-table"><thead><tr><th>Metric</th><th>Why it matters</th><th>How it is calculated</th></tr></thead><tbody>
    ${KPI_DICT.map(([m, w, c]) => `<tr><td><b>${hEsc(m)}</b></td><td>${hEsc(w)}</td><td>${hEsc(c)}</td></tr>`).join('')}</tbody></table>`;
  document.getElementById('kpiDict').showModal();
}
['kpiDictBtn', 'kpiDictBtn2'].forEach(id => document.getElementById(id)?.addEventListener('click', openKpiDict));
document.getElementById('kpiDictClose').addEventListener('click', () => document.getElementById('kpiDict').close());
document.getElementById('kpiDict').addEventListener('click', (e) => { if (e.target.id === 'kpiDict') e.target.close(); });
document.getElementById('kpiMoreBtn').addEventListener('click', (e) => {
  const sec = document.getElementById('execKpis2');
  sec.hidden = !sec.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!sec.hidden));
  e.currentTarget.textContent = sec.hidden ? 'Show 5 more metrics' : 'Show fewer metrics';
});
const setTake = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

/** Lets the browser paint before the next panel is built (a hidden tab doesn't paint, so it doesn't wait). */
const nextFrame = () => new Promise(r => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(() => r())));

/**
 * One story, top to bottom, each chapter answering one question and leading to the next:
 *   1. Is the fleet healthy? (hero)  2. Where does it need attention?  3. What is degrading?
 *   4. What should we do this week?  5. What value have the models delivered?
 * Each figure appears in one place only. Both requests start at once; the hero is drawn
 * from the (small) summary first, then the chapters follow in page order, one per frame.
 */
async function loadHome() {
  skeletons();
  const summaryReq = fetch('/api/dashboard/summary').then(r => r.json());
  const overviewReq = fetch('/api/dashboard/overview').then(r => r.json()).catch(() => ({}));
  // One panel's problem never blanks the page.
  const run = fn => { try { fn(); } catch (err) { console.error('Command Center panel failed', err); } };
  const s = await summaryReq;
  if (s && s.error) throw new Error(s.error);
  run(() => renderHero(s));
  const o = (await overviewReq) || {};
  const steps = [
    () => renderExecSummary(s, o),
    () => renderFleetHealth(s, o), () => renderHealthBu(o), () => renderAssets(s, o),
    () => renderIssues(s, o),
    () => renderActionCenter(s, o), () => renderAttention(o),
    () => renderValue(s, o), () => renderIncidents(o), () => renderValueBu(s, o), () => renderValueCrit(o),
  ];
  for (const fn of steps) { run(fn); await nextFrame(); }
  // Then the other tabs load in the background while the browser is idle, so they open
  // instantly. The Command Center always comes first; the Assistant loads its own when idle.
  (window.requestIdleCallback || (f => setTimeout(f, 1000)))(() => {
    if (window.loadExplorer) window.loadExplorer();
    if (window.loadMonitoring) window.loadMonitoring({ maxAgeMs: 60_000 });
  }, { timeout: 3000 });
}

/** "1,234 of 1,886", or just the first number when the second isn't known yet. */
const ofN = (a, b) => (num(a) === null ? '—' : num(b) === null ? count(a) : `${count(a)} of ${count(b)}`);
const rulesOf = o => {
  const r = o.rules || {};
  return { score: num(r.low_confidence_score) ?? 0.6, share: num(r.low_confidence_model_share) ?? 0.2,
    drift: num(r.drift_alert_threshold) ?? 0.3, fp: num(r.false_positive_rate_threshold) ?? 0.25 };
};
const plural = (n, one, many) => (Math.round(num(n)) === 1 ? one : many);

/** 1. Is the fleet healthy? The verdict, the health split, and the four headline figures. */
function renderHero(s) {
  document.getElementById('heroGreeting').textContent = greeting();
  const models = num(s.models), healthy = num(s.healthy_models), drifting = num(s.drifting_models);
  const lowOnly = num(s.low_confidence_only_models), hca = num(s.high_criticality_needing_attention);
  document.getElementById('heroSub').innerHTML = !drifting && !lowOnly
    ? `All <b>${count(models)}</b> models are healthy.`
    : `<b>${ofN(healthy, models)}</b> models are healthy. <b>${count(drifting)}</b> ${plural(drifting, 'is', 'are')} drifting and <b>${count(lowOnly)}</b> more report low confidence` +
      (hca ? `; <b>${count(hca)}</b> of them ${plural(hca, 'is', 'are')} business-critical.` : '.');
  document.getElementById('heroProgress').innerHTML = healthStack(healthy, lowOnly, drifting) + `
    <div class="hp-legend"><span><i class="cnx-dot" style="background:${HEALTH_COLORS.Healthy}"></i> healthy ${count(healthy)} · <i class="cnx-dot" style="background:${HEALTH_COLORS['Low confidence']}"></i> low confidence ${count(lowOnly)} · <i class="cnx-dot" style="background:${HEALTH_COLORS.Drifting}"></i> drifting ${count(drifting)}</span><span>health on the latest day</span></div>`;
  document.getElementById('heroStats').innerHTML = [
    ['Models monitored', count(models), `${count(s.sites)} sites · ${count(s.business_units)} business units`, 'pulse'],
    ['Predictions scored', count(s.predictions), `${pct(s.verified_share, 0)} verified against actual values`, 'check'],
    ['Alerts confirmed', ofN(s.confirmed_incidents, s.alerts), `${pct(s.alert_precision, 0)} were real incidents`, 'bell'],
    ['Estimated value', money(s.cost_savings_usd), `${count(s.downtime_avoided_hours)} hours of downtime avoided`, 'cash'],
  ].map(([l, v, sub, ic]) => `<div class="hs"><div class="hs-ico">${icon(ic)}</div><div><div class="hs-l">${l}</div><div class="hs-v">${v}</div><div class="hs-s">${sub}</div></div></div>`).join('');
  // Load time from the warehouse is UTC; shown in the viewer's local time.
  const loaded = (v) => { const d = v ? new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z')) : null; return d && !isNaN(d) ? d.toLocaleString() : v; };
  document.getElementById('heroNote').innerHTML =
    `<div><b>Monitoring window:</b> ${when(s.window_from)} to ${when(s.as_of)} (${count(s.days_in_window)} days, one prediction per model per minute). "Now" is the end of the window; health is judged on its latest day.</div>` +
    (s.data_refreshed_at ? `<div class="hero-refresh">Data loaded on ${loaded(s.data_refreshed_at)}</div>` : '');
}

/**
 * Executive summary: the five chapters in five plain lines, plus a bottom line.
 * Written from the same certified figures as the chapters, so it can't drift from them.
 * Each line jumps to its chapter.
 */
function renderExecSummary(s, o) {
  const a = o.actions;
  if (!a) return;   // the overview hasn't arrived yet: the skeleton stays
  const bu = (o.healthByBu || [])[0];
  const worstAsset = (o.assets || []).slice().sort((x, y) => num(y.avg_error_pct) - num(x.avg_error_pct))[0];
  const top = (o.incidents || [])[0];
  const share = top && num(s.cost_savings_usd) ? num(top.cost_savings_usd) / num(s.cost_savings_usd) : null;
  const attention = num(s.models_needing_attention), hca = num(s.high_criticality_needing_attention);
  document.getElementById('execSumBottom').innerHTML = `<span class="es-bl">Bottom line</span>${hEsc(
    `${count(s.healthy_models)} of ${count(s.models)} models are healthy and the fleet saved an estimated ${money(s.cost_savings_usd)}; ` +
    `review the ${count(s.drifting_models)} drifting ${plural(s.drifting_models, 'model', 'models')} first${hca ? ` and the ${count(hca)} business-critical ${plural(hca, 'model', 'models')} needing attention` : ''}.`)}`;
  const rows = [
    ['ch1', 'Fleet health', `${count(s.healthy_models)} of ${count(s.models)} models are healthy; ${count(attention)} need attention${hca ? `, ${count(hca)} of them business-critical` : ''}.`,
      pct(num(s.healthy_models) / num(s.models), 0), 'healthy', attention ? 'warn' : 'good'],
    ['ch2', 'Where attention is needed', `${bu ? `${bu.business_unit} has the most models needing attention (${ofN(bu.models_needing_attention, bu.models)})` : 'Attention is spread across the fleet'}` +
      `${worstAsset ? `; ${worstAsset.asset_type.toLowerCase()} models have the highest error (${pct(worstAsset.avg_error_pct, 0)} of actual values)` : ''}.`,
      count(bu ? bu.models_needing_attention : attention), bu ? `in ${bu.business_unit}` : 'models', 'warn'],
    ['ch3', 'What is degrading', `${count(s.drifting_models)} ${plural(s.drifting_models, 'model is', 'models are')} drifting (average drift from ${dec(s.drifting_first_avg_drift)} to ${dec(s.drifting_latest_avg_drift)} in ${count(s.days_in_window)} days), and ${pct(s.false_positive_rate, 0)} of alerts were false alarms.`,
      count(s.drifting_models), 'drifting', 'bad'],
    ['ch4', 'This week', `Review ${count(a.retrain_review_models)} drifting ${plural(a.retrain_review_models, 'model', 'models')}, investigate ${count(a.investigate_confidence_models)} low-confidence ${plural(a.investigate_confidence_models, 'model', 'models')}, tune alerts on ${count(a.tune_alert_models)}` +
      `${num(a.unanswered_alert_hours) ? `, and close ${count(a.unanswered_alert_hours)} unanswered alert ${plural(a.unanswered_alert_hours, 'hour', 'hours')}` : ''}.`,
      count(a.models_with_action), 'models with a next step', 'warn'],
    ['ch5', 'Value delivered', `${money(s.cost_savings_usd)} saved and ${count(s.downtime_avoided_hours)} hours of downtime avoided across ${count(s.incidents)} incidents${share !== null ? `; the largest is ${pct(share, 0)} of the savings` : ''}.`,
      money(s.cost_savings_usd), 'estimated savings', 'good'],
  ];
  document.getElementById('execSumList').innerHTML = rows.map(([id, label, line, fig, figLabel, t], i) => `
    <li><a class="es-row" href="#${id}">
      <span class="es-n">${i + 1}</span>
      <span class="es-text"><span class="es-label">${hEsc(label)}</span><span class="es-line">${hEsc(line)}</span></span>
      <span class="es-fig es-${t}"><b>${fig}</b><small>${hEsc(figLabel)}</small></span>
    </a></li>`).join('');
}

/** 2. Where does the fleet need attention? Health cards, then by business unit and asset type. */
function renderFleetHealth(s, o) {
  const r = rulesOf(o);
  const hca = num(s.high_criticality_needing_attention);
  setTake('ch2Take', `<b>${ofN(s.models_needing_attention, s.models)}</b> models need attention: <b>${count(s.drifting_models)}</b> drifting and <b>${count(s.low_confidence_only_models)}</b> with low confidence` +
    (hca ? `, including <b>${count(hca)}</b> business-critical ${plural(hca, 'model', 'models')}` : '') +
    `. <b>${pct(s.verified_share, 0)}</b> of predictions have been checked against actual values so far; the rest arrive later.`);
  const card = (ic, label, value, sub, why, t, view = '') => `
    <div class="xkpi${t ? ' x-' + t : ''}" title="${hEsc(why)}">
      <div class="xkpi-top">${icon(ic, 'ico-sm')}<span>${label}</span></div>
      <div class="xkpi-v">${value}</div>
      <div class="xkpi-s">${sub}</div>
      <div class="xkpi-why">${hEsc(why)}</div>${view}
    </div>`;
  document.getElementById('execKpis').innerHTML = [
    card('check', 'Healthy models', count(s.healthy_models), `${ofN(s.healthy_models, s.models)} models: neither drifting nor low-confidence`, 'Health is judged on the latest day', null,
      viewBtn('healthy', 'View models', '', 'Healthy models', true)),
    card('slip', 'Drifting models', count(s.drifting_models), `average drift ${dec(r.drift)} or more on the latest day · up from ${dec(s.drifting_first_avg_drift)} to ${dec(s.drifting_latest_avg_drift)}`,
      'The data these models see has moved away from what they learned', num(s.drifting_models) ? 'bad' : null, viewBtn('drifting', 'View models', '', 'Drifting models', true)),
    card('alert', 'Low-confidence models', count(s.low_confidence_models), `at least ${pct(r.share, 0)} of latest-day predictions below ${pct(r.score, 0)} confidence`,
      'Models that are often unsure of their own outputs', num(s.low_confidence_models) ? 'warn' : null, viewBtn('low_confidence', 'View models', '', 'Low-confidence models', true)),
    card('shield', 'Business-critical needing attention', count(hca), `of ${count(s.high_criticality_models)} High-criticality models`,
      'Drifting or low-confidence models rated High criticality', hca ? 'warn' : null, viewBtn('high_crit_attention', 'View models', '', 'Business-critical models needing attention', true)),
    card('pulse', 'Verified against actuals', pct(s.verified_share, 0), `${ofN(s.verified_predictions, s.predictions)} predictions have an actual value`,
      'Ground-truth coverage; actual values arrive later, so about 30% missing is expected'),
  ].join('');
  document.getElementById('execKpis2').innerHTML = [
    card('target', 'Average confidence', pct(s.avg_confidence, 1), `${pct(s.low_confidence_share, 1)} of predictions below ${pct(r.score, 0)} (${ofN(s.low_confidence_predictions, s.predictions)})`, 'How sure the models are of their outputs'),
    card('bell', 'Alert precision', pct(s.alert_precision, 0), `${ofN(s.confirmed_incidents, s.alerts)} alerts confirmed as real incidents`, 'Whether alerts can be trusted'),
    card('alert', 'False alarm rate', pct(s.false_positive_rate, 0), `${ofN(s.false_positives, s.alerts)} alerts were not real`, 'Alerts that cost attention without an incident', num(s.false_positive_rate) > r.fp ? 'warn' : null,
      viewBtn('high_fp', 'View models', '', 'Models with more than 1 in 4 false alarms', true)),
    card('clock', 'Scoring latency', num(s.avg_latency_ms) === null ? '—' : `${num(s.avg_latency_ms).toFixed(0)} ms`, `average per prediction · slowest model's p95 ${count(s.worst_p95_latency_ms)} ms`, 'How fast models answer'),
    card('bell', 'Models that raised alerts', count(s.models_with_alerts), `${count(s.incidents)} incidents · ${count(s.alerts)} alerts in total`, 'Models that flagged anomalies in the window', null,
      viewBtn('with_alerts', 'View models', '', 'Models that raised alerts', true)),
  ].join('');
}

/** 2. (continued) Health by business unit. */
function renderHealthBu(o) {
  const rows = o.healthByBu || [];
  const body = `<div class="table-scroll flat"><table class="mini risk-table"><thead><tr><th>Business unit</th><th>Models</th><th>Health</th><th>Need attention</th><th>Avg confidence</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${hEsc(r.business_unit)}</td><td>${count(r.models)}</td>
      <td style="min-width:110px">${healthStack(r.healthy_models, r.low_confidence_models, r.drifting_models)}</td>
      <td>${num(r.models_needing_attention) ? `<b>${count(r.models_needing_attention)}</b>` : '<span class="muted">0</span>'}</td><td>${pct(r.avg_confidence, 1)}</td>
      <td>${viewBtn(num(r.models_needing_attention) ? 'business_unit_attention' : 'business_unit', 'View', r.business_unit,
        num(r.models_needing_attention) ? `${r.business_unit}: models needing attention` : `${r.business_unit}: models`, true)}</td></tr>`).join('')}</tbody></table></div>
    <div class="panel-note">Green healthy · amber low confidence · red drifting. "View" lists the models needing attention, or all of the unit's models when none do.</div>`;
  panel('pnlHealthBu', 'Health by business unit', 'Models needing attention in each unit',
    { q: 'Which business units have the most models needing attention, and what is wrong with them?', mode: 'agent' }, body);
}

/** 2. (continued) Health and accuracy by asset type. */
function renderAssets(s, o) {
  const rows = (o.assets || []).slice().sort((a, b) => num(b.avg_error_pct) - num(a.avg_error_pct));
  const max = Math.max(...rows.map(r => num(r.avg_error_pct) || 0), 0.0001);
  const fleet = rows.reduce((a, r) => a + num(r.avg_error_pct) * num(r.models), 0) / (rows.reduce((a, r) => a + num(r.models), 0) || 1);
  panel('pnlAssets', 'Accuracy and health by asset type', `Error as a share of actual values, averaged over each type's models (fleet ${pct(fleet, 1)}, marker).`,
    { q: 'Compare model accuracy by asset type: which asset types have the least accurate models, and which models are the worst?', mode: 'agent' },
    rows.map((r, i) => bar(hEsc(r.asset_type), num(r.avg_error_pct), max * 1.05, pct(r.avg_error_pct, 1), i < 2 && num(r.avg_error_pct) > fleet * 1.5 ? 'bad' : 'brand',
      `${count(r.models)} models · ${num(r.models_needing_attention) ? `<b>${count(r.models_needing_attention)}</b> need attention` : 'none need attention'} ${viewBtn('asset', 'View', r.asset_type, `${r.asset_type} models`, true)}`, fleet)).join('')
    + '<div class="panel-note">Models predict in different units (°C, indices, probabilities), so error is compared as a share of actual values. Probability models have small actual values, so the same absolute error is a larger share.</div>');
}

/** 3. What is degrading? The issues, most severe first (one list). */
function renderIssues(s, o) {
  const r = rulesOf(o);
  const att = o.attention || [];
  const drifting = att.filter(m => m.health_status === 'Drifting');
  const lowConf = att.filter(m => m.health_status === 'Low confidence');
  const hcaLow = lowConf.filter(m => m.criticality === 'High');
  const worstFp = (o.incidents || []).slice().sort((a, b) => num(b.false_positive_rate) - num(a.false_positive_rate))[0];
  const worstAsset = (o.assets || []).slice().sort((a, b) => num(b.avg_error_pct) - num(a.avg_error_pct))[0];
  const fleetErr = (o.assets || []).reduce((a, x) => a + num(x.avg_error_pct) * num(x.models), 0) / ((o.assets || []).reduce((a, x) => a + num(x.models), 0) || 1);
  const unanswered = (o.incidents || []).filter(i => num(i.unanswered_alerts) > 0);
  const names = list => list.map(m => m.model_name).join(', ');
  setTake('ch3Take', `<b>${count(s.drifting_models)}</b> ${plural(s.drifting_models, 'model is', 'models are')} drifting steadily over the whole window` +
    `, and <b>${pct(s.false_positive_rate, 0)}</b> of alerts were false alarms. Low confidence affects <b>${count(s.low_confidence_models)}</b> models` +
    (hcaLow.length ? `, including business-critical ${hEsc(hcaLow[0].model_name)}.` : '.'));
  const issues = [
    num(s.drifting_models) && { sev: drifting.some(m => m.criticality === 'High') ? 'Critical' : 'High', ic: 'slip', view: ['drifting', `View ${count(s.drifting_models)} drifting models`],
      title: `${count(s.drifting_models)} ${plural(s.drifting_models, 'model is', 'models are')} drifting`, metric: `${dec(s.drifting_first_avg_drift)} → ${dec(s.drifting_latest_avg_drift)}`,
      body: `Average drift on ${names(drifting)} rose from ${dec(s.drifting_first_avg_drift)} to ${dec(s.drifting_latest_avg_drift)} over ${count(s.days_in_window)} days, while the rest of the fleet stayed near ${dec(s.others_latest_avg_drift)}.` +
        ` ${drifting.some(m => m.criticality === 'High') ? 'At least one is business-critical.' : 'None is business-critical.'}`,
      check: 'What changed in these models\' input data; the cause needs engineering review before retraining.',
      q: 'Which models are showing drift this week, how fast is it rising, and which sites and business units are affected?' },
    num(s.low_confidence_models) && { sev: hcaLow.length ? 'High' : 'Medium', ic: 'alert', view: ['low_confidence', `View ${count(s.low_confidence_models)} low-confidence models`],
      title: `${count(s.low_confidence_models)} models report low confidence`, metric: pct(s.low_confidence_share, 1),
      body: `At least ${pct(r.share, 0)} of their predictions on the latest day were below ${pct(r.score, 0)} confidence` +
        (hcaLow.length ? `; ${names(hcaLow)} ${plural(hcaLow.length, 'is', 'are')} business-critical` : '') +
        `. Across the fleet, ${pct(s.low_confidence_share, 1)} of all predictions are low-confidence (${ofN(s.low_confidence_predictions, s.predictions)}).`,
      check: 'Inputs and calibration of these models before their outputs are relied on.',
      q: 'Which models have low confidence, how low, and which of them are business-critical?' },
    num(s.alerts) && { sev: num(s.false_positive_rate) > r.fp ? 'High' : 'Medium', ic: 'bell', view: ['high_fp', 'View models raising false alarms'],
      title: `${pct(s.false_positive_rate, 0)} of alerts were false alarms`, metric: `${count(s.false_positives)} alerts`,
      body: `${ofN(s.false_positives, s.alerts)} alerts were not confirmed as real incidents. ${count(s.high_false_positive_models)} ${plural(s.high_false_positive_models, 'model is', 'models are')} above ${pct(r.fp, 0)}` +
        (worstFp ? `, the highest ${worstFp.model_name} at ${pct(worstFp.false_positive_rate, 0)}` : '') + '.',
      check: 'The alert thresholds of the models above 1 in 4 false alarms.',
      q: 'How many of our alerts are false alarms, which models and versions raise the most, and what should we review?' },
    worstAsset && { sev: 'Medium', ic: 'target', view: ['asset', `View ${worstAsset.asset_type} models`, worstAsset.asset_type],
      title: `${worstAsset.asset_type} models are the least accurate`, metric: pct(worstAsset.avg_error_pct, 0),
      body: `Their predictions are off by ${pct(worstAsset.avg_error_pct, 1)} of actual values on average, against ${pct(fleetErr, 1)} across all models.`,
      check: 'Whether this error level is acceptable for how the predictions are used; probability targets have small actual values, so their error reads larger.',
      q: `Which ${worstAsset.asset_type} models are least accurate, and how do they compare with the rest of the fleet?` },
    unanswered.length && { sev: 'Medium', ic: 'clock', view: ['unanswered', 'View the model'],
      title: `${count(s.unanswered_alerts)} alerts went unanswered`, metric: `${count(s.unanswered_alerts)} alerts`,
      body: unanswered.map(i => `On ${i.model_name} (${i.site_name}), the incident from ${when(i.incident_start, false)} had ${count(i.unanswered_alerts)} alerts recorded as "Ignored"; responses: ${i.responses}.`).join(' '),
      check: 'That every alert reaches someone who acts on it, at any hour.',
      q: 'Which alerts were ignored or not acted on, and what happened in those incidents?' },
  ].filter(Boolean);
  document.getElementById('issues').innerHTML = issues.map((c, i) => `
    <div class="prio issue sev-${c.sev.toLowerCase()}">
      <div class="prio-top"><span class="prio-rank">${i + 1}</span><span class="sev-tag">${c.sev}</span><span class="prio-metric">${c.metric}</span></div>
      <div class="prio-title">${icon(c.ic, 'ico-sm')} ${hEsc(c.title)}</div>
      <div class="prio-body">${hEsc(c.body)}</div>
      <div class="issue-driver"><b>What to check:</b> ${hEsc(c.check)}</div>
      <div class="card-btns">${viewBtn(c.view[0], c.view[1], c.view[2] || '', c.title)}${askBtn(c.q, 'agent', 'Ask Lens why')}</div>
    </div>`).join('') || '<div class="empty-note">Nothing is degrading: every model is healthy and alerts are reliable.</div>';
}

/** 4. What should we do this week? The work queues, most urgent first; together they are the plan. */
function renderActionCenter(s, o) {
  const a = o.actions || {};
  const r = rulesOf(o);
  setTake('ch4Take', `Review the <b>${count(a.retrain_review_models)}</b> drifting ${plural(a.retrain_review_models, 'model', 'models')} first, then investigate <b>${count(a.investigate_confidence_models)}</b> low-confidence ${plural(a.investigate_confidence_models, 'model', 'models')}` +
    (num(a.investigate_confidence_high_criticality) ? ` (${count(a.investigate_confidence_high_criticality)} business-critical)` : '') +
    `, tune alerts on <b>${count(a.tune_alert_models)}</b> and close the loop on <b>${count(a.unanswered_alert_hours)}</b> unanswered alert ${plural(a.unanswered_alert_hours, 'hour', 'hours')}. Each model sits in one queue only.`);
  const cards = [
    { ic: 'slip', when: 'Today', list: 'queue_retrain', t: 'Review drift and plan retraining', v: count(a.retrain_review_models), unit: 'models',
      d: `Average drift ${dec(r.drift)} or more on the latest day. Check what changed in the input data, then plan retraining with a before-and-after comparison.`,
      q: 'Which models are drifting, what has changed in their inputs, and how should we plan their review and retraining?', mode: 'agent', tone: 'bad' },
    { ic: 'alert', when: 'This week', list: 'queue_confidence', t: 'Investigate low confidence', v: count(a.investigate_confidence_models), unit: 'models',
      d: `At least ${pct(r.share, 0)} of latest-day predictions below ${pct(r.score, 0)} confidence${num(a.investigate_confidence_high_criticality) ? `; ${count(a.investigate_confidence_high_criticality)} business-critical, so start there` : ''}.`,
      q: 'Which models have low confidence, how low, and which of them are business-critical?', mode: 'agent', tone: 'warn' },
    { ic: 'bell', when: 'This week', list: 'queue_tune', t: 'Tune alert thresholds', v: count(a.tune_alert_models), unit: 'models',
      d: `${ofN(a.tune_alert_false_positives, a.tune_alert_alerts)} of their alerts were false alarms (more than ${pct(r.fp, 0)}).`,
      q: 'Which models raise the most false alarms, and how many of their alerts were confirmed?', mode: 'chat', tone: 'brand' },
    { ic: 'clock', when: 'This week', list: 'unanswered', t: 'Close the loop on unanswered alerts', v: count(a.unanswered_alert_hours), unit: plural(a.unanswered_alert_hours, 'alert hour', 'alert hours'),
      d: 'Alerts recorded as "Ignored" or with no response. Confirm the alert route reaches someone at every hour.',
      q: 'Which alerts were ignored or not acted on, and what happened in those incidents?', mode: 'agent', tone: 'good' },
  ];
  document.getElementById('actionCenter').innerHTML = cards.map((c, i) => `
    <div class="act-card t-${c.tone}">
      <div class="act-step"><span class="prio-rank">${i + 1}</span><span class="act-when">${c.when}</span></div>
      <div class="act-top">${icon(c.ic, 'ico-sm')}<span>${hEsc(c.t)}</span></div>
      <div class="act-v">${c.v} <small>${hEsc(c.unit)}</small></div>
      <div class="act-d">${hEsc(c.d)}</div>
      <div class="card-btns">${viewBtn(c.list, 'View models', '', c.t)}${askBtn(c.q, c.mode)}</div>
    </div>`).join('');
}

/** 4. (continued) Every model with a next step, in queue order. */
function renderAttention(o) {
  const rows = o.attention || [];
  const signal = r => r.health_status === 'Drifting' ? `drift ${dec(r.first_day_avg_drift)} → ${dec(r.latest_day_avg_drift)}`
    : r.health_status === 'Low confidence' ? `${pct(r.latest_day_low_confidence_share, 0)} of predictions low-confidence`
    : num(r.false_positive_rate) && r.recommended_action === 'Tune alert threshold' ? `${pct(r.false_positive_rate, 0)} false alarms`
    : `${count(r.unanswered_alert_hours)} unanswered alert ${plural(r.unanswered_alert_hours, 'hour', 'hours')}`;
  const body = `<div class="table-scroll flat"><table class="nice">
    <thead><tr><th>Model</th><th>Business unit · site</th><th>Criticality</th><th>Health</th><th>Signal</th><th>Next step</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${modelCell(r)}</td><td>${hEsc(r.business_unit)} <span class="muted">· ${hEsc(r.site_name)}</span></td>
      <td>${hEsc(r.criticality)}</td><td>${healthTag(r.health_status)}</td><td>${hEsc(signal(r))}</td><td>${actionChip(r.recommended_action)}</td></tr>`).join('')}</tbody></table></div>`;
  panel('pnlAttention', 'Every model with a next step', `${count(rows.length)} models, in queue order, business-critical first within each queue. ${viewBtn('with_action', 'View and export', '', 'Models with a next step', true)}`,
    { q: 'Which models need action first, and why? Rank them by business risk.', mode: 'agent' }, rows.length ? body : '<div class="empty-note">No model needs action.</div>');
}

/** 5. What value have the models delivered? The incidents, by business unit and by criticality. */
function renderValue(s, o) {
  const top = (o.incidents || [])[0];
  const share = top && num(s.cost_savings_usd) ? num(top.cost_savings_usd) / num(s.cost_savings_usd) : null;
  setTake('ch5Take', `The models caught <b>${count(s.incidents)}</b> incidents: <b>${ofN(s.confirmed_incidents, s.alerts)}</b> alerts were confirmed, avoiding an estimated <b>${count(s.downtime_avoided_hours)}</b> hours of downtime and <b>${money(s.cost_savings_usd)}</b> in costs.` +
    (top && share !== null ? ` The value is concentrated: one incident, on ${hEsc(top.model_name)} at ${hEsc(top.site_name)}, is <b>${pct(share, 0)}</b> of it.` : ''));
}

function renderIncidents(o) {
  const rows = o.incidents || [];
  const body = `<div class="table-scroll flat"><table class="nice">
    <thead><tr><th>Model</th><th>Site · business unit</th><th>When</th><th>Alerts confirmed</th><th>Downtime avoided</th><th>Savings</th><th>Response</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${modelCell(r)} <span class="muted">· ${hEsc(r.asset_type)}, ${hEsc(r.criticality)}</span></td>
      <td>${hEsc(r.site_name)} <span class="muted">· ${hEsc(r.business_unit)}</span></td>
      <td>${when(r.incident_start, false)} <span class="muted">to ${hEsc(String(r.incident_end || '').slice(11, 16))} · ${count(r.duration_minutes)} min</span></td>
      <td>${ofN(r.confirmed_incidents, r.alerts)} <span class="muted">(${pct(num(r.confirmed_incidents) / num(r.alerts), 0)})</span></td>
      <td>${count(r.downtime_avoided_hours)} h</td><td><b>${money(r.cost_savings_usd)}</b></td><td>${hEsc(r.responses)}</td>
      <td><button class="view-btn sm" data-incident="${hEsc(r.incident_id)}" data-title="${hEsc(`${r.model_name}: alerts from ${when(r.incident_start, false)}`)}">View alerts</button></td></tr>`).join('')}</tbody></table></div>`;
  panel('pnlIncidents', 'The incidents the models caught', 'Largest savings first. An incident is consecutive hours with alerts on one model.',
    { q: 'Which incidents did the models catch, how quickly were they acted on, and what did each one save?', mode: 'agent' },
    rows.length ? body : '<div class="empty-note">No incidents in the monitoring window.</div>');
}

function renderValueBu(s, o) {
  const rows = o.valueByBu || [];
  const max = Math.max(...rows.map(r => num(r.cost_savings_usd) || 0), 1);
  panel('pnlValueBu', 'Savings by business unit', `Estimated savings, ${money(s.cost_savings_usd)} in total.`,
    { q: 'Which business units delivered the most value, and which incidents drove it?', mode: 'agent' },
    rows.map(r => bar(hEsc(r.business_unit), num(r.cost_savings_usd), max, `${money(r.cost_savings_usd)} <span class="muted">(${pct(r.share_of_savings, 0)})</span>`, num(r.cost_savings_usd) ? 'good' : 'brand',
      `${num(r.confirmed_incidents) ? `${count(r.confirmed_incidents)} confirmed incidents · ${count(r.downtime_avoided_hours)} h downtime avoided` : 'no incidents in the window'} ${viewBtn('business_unit', 'View', r.business_unit, `${r.business_unit}: models`, true)}`)).join('') || '<div class="empty-note">No data.</div>');
}

function renderValueCrit(o) {
  const rows = o.valueByCrit || [];
  const max = Math.max(...rows.map(r => num(r.savings_per_model) || 0), 1);
  const y = o.yieldByAsset || [];
  panel('pnlValueCrit', 'Savings per model by criticality', 'Total savings ÷ models in each criticality band.',
    { q: "What's the ROI of our High-criticality models vs Low-criticality ones?", mode: 'chat' },
    rows.map(r => bar(hEsc(r.criticality), num(r.savings_per_model), max, `${money(r.savings_per_model)} <span class="muted">per model</span>`, 'brand',
      `${count(r.models)} models · ${count(r.models_with_alerts)} with alerts · ${money(r.cost_savings_usd)} in total ${viewBtn('criticality', 'View', r.criticality, `${r.criticality}-criticality models`, true)}`)).join('')
    + (y.length ? `<div class="panel-note"><b>Yield:</b> ${y.map(r => `${hEsc(String(r.asset_type).toLowerCase())} models average ${dec(r.avg_yield_improvement_pct)} points of yield improvement (${count(r.models)} models)`).join('; ')}. Only reactor and furnace models measure yield.</div>` : '')
    + '<div class="panel-note">The data has no model running cost, so this is savings per model, not ROI.</div>');
}

// ---------------------------------------------------------------- the models behind a figure
// Every card can show its models: the same rule as its number, at model level.
const LIST_RULES = {
  all: 'Every model in the fleet.',
  healthy: 'Neither drifting nor low-confidence on the latest day.',
  attention: 'Drifting or low-confidence on the latest day.',
  drifting: 'Average drift score of 0.30 or more on the latest day.',
  low_confidence: 'At least 20% of predictions on the latest day below 60% confidence.',
  high_crit_attention: 'Criticality High, and drifting or low-confidence.',
  high_criticality: 'Criticality High.',
  with_alerts: 'Raised at least one alert in the window.',
  high_fp: 'More than 25% of the model\'s alerts were false alarms.',
  unanswered: 'At least one hour of alerts recorded as "Ignored" or with no response.',
  with_action: 'Has a next step: drifting, low confidence, more than 25% false alarms, or unanswered alerts (first that applies).',
  queue_retrain: 'Queue 1: drifting. Review the input data and plan retraining.',
  queue_confidence: 'Queue 2: low confidence (and not drifting). Investigate inputs and calibration.',
  queue_tune: 'Queue 3: more than 25% false alarms (and healthy). Tune the alert threshold.',
  business_unit: 'All models in this business unit.',
  business_unit_attention: 'Models in this business unit that are drifting or low-confidence.',
  asset: 'All models of this asset type.',
  criticality: 'All models with this criticality.',
};
const viewBtn = (list, label, value = '', title = '', sm = false) =>
  `<button class="view-btn${sm ? ' sm' : ''}" data-models="${list}" data-value="${hEsc(value)}" data-title="${hEsc(title)}">${hEsc(label)}</button>`;
function openModels(list, value, title) {
  return showModelList({
    url: `/api/dashboard/models?list=${encodeURIComponent(list)}${value ? '&value=' + encodeURIComponent(value) : ''}`,
    title, rule: LIST_RULES[list] || '', file: `lens-mlops-${list}${value ? '-' + value.replace(/\W+/g, '-').toLowerCase() : ''}`,
  });
}

const csvCell = v => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function downloadCsv(file, header, cols, rows) {
  const csv = [header, cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${file}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Opens the shared window in its loading state. */
function openListWindow(title, rule) {
  const dlg = document.getElementById('acctDialog');
  document.getElementById('acctTitle').textContent = title || 'Models';
  document.getElementById('acctRule').textContent = rule || '';
  document.getElementById('acctSum').textContent = 'Loading…';
  document.getElementById('acctBody').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel short"></div>';
  document.getElementById('acctCsv').disabled = true;
  if (!dlg.open) dlg.showModal();
}
/** The list's JSON, or null (with a message in the window) when it failed. */
async function fetchList(url) {
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  } catch (err) {
    document.getElementById('acctSum').textContent = 'This list could not be loaded. Please try again.';
    document.getElementById('acctBody').innerHTML = '';
    return null;
  }
}

/** The models window, shared by the Command Center and the Explorer (window.showModelList). */
async function showModelList({ url, title, rule, file }) {
  openListWindow(title, rule);
  const d = await fetchList(url);
  if (!d) return;
  const t = d.totals || {};
  const rows = d.rows || [];
  document.getElementById('acctSum').innerHTML = `<b>${count(t.models)}</b> ${plural(t.models, 'model', 'models')} · <b>${count(t.alerts)}</b> alerts (${count(t.confirmed_incidents)} confirmed) · ` +
    `<b>${money(t.cost_savings_usd)}</b> estimated savings · <b>${count(t.downtime_avoided_hours)}</b> hours of downtime avoided`;
  document.getElementById('acctBody').innerHTML = rows.length ? `<table class="nice"><thead><tr><th>Model</th><th>Business unit · site</th><th>Asset</th><th>Criticality</th><th>Health</th>
      <th>Confidence <span class="muted">(latest day)</span></th><th>Drift</th><th>Error</th><th>Alerts</th><th>Savings</th><th>Next step</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${modelCell(r)}</td>
      <td>${hEsc(r.business_unit)} <span class="muted">· ${hEsc(r.site_name)}</span></td><td>${hEsc(r.asset_type)}</td><td>${hEsc(r.criticality)}</td>
      <td>${healthTag(r.health_status)}</td>
      <td>${pct(r.latest_day_avg_confidence, 0)} <span class="muted">· ${pct(r.latest_day_low_confidence_share, 0)} below 60%</span></td>
      <td>${dec(r.latest_day_avg_drift)} <span class="muted">from ${dec(r.first_day_avg_drift)}</span></td>
      <td>${pct(r.error_pct, 1)}</td>
      <td>${num(r.alerts) ? `${ofN(r.confirmed_incidents, r.alerts)} <span class="muted">confirmed</span>` : '<span class="muted">none</span>'}</td>
      <td>${num(r.cost_savings_usd) ? `<b>${money(r.cost_savings_usd)}</b>` : '<span class="muted">—</span>'}</td>
      <td>${actionChip(r.recommended_action)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-note">No models match.</div>';
  document.getElementById('acctCsv').disabled = !rows.length;
  document.getElementById('acctCsv').onclick = () => downloadCsv(file || 'lens-mlops-models', `# ${title}: ${rule || ''}`,
    ['model_id', 'model_name', 'business_unit', 'site_name', 'asset_type', 'criticality', 'owner_team', 'model_version', 'health_status',
      'latest_day_avg_confidence', 'latest_day_low_confidence_share', 'first_day_avg_drift', 'latest_day_avg_drift', 'error_pct', 'mae', 'unit_of_measure',
      'alerts', 'confirmed_incidents', 'false_positive_rate', 'downtime_avoided_hours', 'cost_savings_usd', 'recommended_action'], rows);
}
window.showModelList = showModelList;

/** The alerts behind one incident, minute by minute. */
async function showAlertList(incident, title) {
  openListWindow(title, 'Every prediction this model flagged as an anomaly during the incident. Actual values arrive later for some minutes.');
  const d = await fetchList(`/api/dashboard/alerts?incident=${encodeURIComponent(incident)}`);
  if (!d) return;
  const t = d.totals || {};
  const rows = d.rows || [];
  const unit = rows[0] ? rows[0].unit_of_measure : '';
  document.getElementById('acctSum').innerHTML = `<b>${count(t.alerts)}</b> alerts · <b>${count(t.verified)}</b> with an actual value · peak prediction <b>${dec(t.peak_predicted_value)}</b> ${hEsc(unit)} · average confidence <b>${pct(t.avg_confidence, 0)}</b>`;
  document.getElementById('acctBody').innerHTML = `<table class="nice"><thead><tr><th>Time</th><th>Predicted</th><th>Actual</th><th>Error</th><th>Confidence</th><th>Drift</th><th>Latency</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="mono">${hEsc(r.prediction_time)}</td><td>${dec(r.predicted_value, 3)} <span class="muted">${hEsc(r.unit_of_measure)}</span></td>
      <td>${num(r.actual_value) === null ? '<span class="muted">not yet</span>' : dec(r.actual_value, 3)}</td><td>${num(r.prediction_error) === null ? '<span class="muted">—</span>' : dec(r.prediction_error, 3)}</td>
      <td>${pct(r.confidence_score, 0)}</td><td>${dec(r.drift_score)}</td><td>${count(r.latency_ms)} ms</td></tr>`).join('')}</tbody></table>`;
  document.getElementById('acctCsv').disabled = !rows.length;
  document.getElementById('acctCsv').onclick = () => downloadCsv(`lens-mlops-alerts-${incident.replace(/\W+/g, '-').toLowerCase()}`, `# ${title}`,
    ['prediction_time', 'model_id', 'model_name', 'site_name', 'unit_of_measure', 'predicted_value', 'actual_value', 'prediction_error', 'confidence_score', 'drift_score', 'latency_ms'], rows);
}

document.getElementById('acctClose').addEventListener('click', () => document.getElementById('acctDialog').close());
document.getElementById('acctDialog').addEventListener('click', (e) => { if (e.target.id === 'acctDialog') e.target.close(); });
document.getElementById('tab-home').addEventListener('click', (e) => {
  const b = e.target.closest('[data-models]');
  if (b) { openModels(b.dataset.models, b.dataset.value, b.dataset.title); return; }
  const i = e.target.closest('[data-incident]');
  if (i) showAlertList(i.dataset.incident, i.dataset.title);
});

// The story bar follows the reader: the chapter in view is highlighted.
if (window.IntersectionObserver) {
  const links = [...document.querySelectorAll('.story-nav a')];
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting) return;
    const id = e.target.id === 'homeHero' ? 'ch1' : e.target.id;
    links.forEach(l => l.classList.toggle('on', l.getAttribute('href') === '#' + id));
  }), { rootMargin: '-40% 0px -55% 0px' });
  ['homeHero', 'ch2', 'ch3', 'ch4', 'ch5'].forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
}

loadHome().catch(err => {
  console.error('Command Center failed to load', err);
  document.getElementById('heroSub').textContent = 'Some figures could not be loaded. Please refresh the page.';
});
