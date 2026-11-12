// ---------------------------------------------------------------- Command Center
// The one-minute view of the model fleet, told as one story in five chapters: are we on track
// this month, how healthy is the fleet, what's hurting us, what to do and when, and the value
// delivered and the upside left. Serving, SLA, cost, feature drift, retraining, promotions,
// governance and recorded causes come from synthetic demo data (labelled on the page). The "why" (drill-downs by business unit, site, asset type,
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
// The thresholds in force (gold.qry_rules, set when the summary loads), so a sentence that names one
// states the value the figures use. The defaults are only for the moment before the summary arrives.
let RULES = { score: 0.6, share: 0.2, drift: 0.3, fp: 0.25, sla: 0.999, slo: 200, psi: 0.25, psiN: 3, accWatch: 0.05, accRollback: 0.1,
  stale: 90, overdue: 14, cardAge: 180, gpuUtil: 25, idle: 1000, runRate: 3 };
const rPct = v => `${Math.round(Number(v) * 100)}%`;
const rDec = v => Number(v).toFixed(2);

// One place that says what every figure means and how it is calculated (the "KPI Dict").
const kpiDict = r => [
  ['Monitoring window', 'The period the health, accuracy and value figures cover.', 'From the first to the latest prediction in the data (three days, one prediction per model per minute). "Now" and "the latest day" mean the end of the window. "This month" is the month up to the latest day.'],
  ['Healthy model', 'A model whose outputs can be relied on today.', 'Neither drifting nor low-confidence on the latest day.'],
  ['Drifting model', 'The data the model sees has moved away from what it learned.', `Average drift score on the latest day of ${rDec(r.drift)} or more (business rule drift_alert_threshold).`],
  ['Low-confidence prediction', 'A prediction the model itself is unsure of.', `Confidence score below ${rDec(r.score)} (business rule low_confidence_score).`],
  ['Low-confidence model', 'A model that is often unsure of itself.', `At least ${rPct(r.share)} of its predictions on the latest day are low-confidence (business rule low_confidence_model_share).`],
  ['Needs attention', 'Models to look at before relying on them.', 'Drifting or low-confidence. Business-critical = criticality High.'],
  ['Verified against actuals', 'How much of the output can be checked yet.', 'Predictions with an actual value ÷ all predictions. About 30% have no actual value yet because it arrives later; that is expected.'],
  ['Error (% of actual)', 'How far predictions are from what happened, comparable across models.', 'For each model: sum of |actual − predicted| ÷ sum of |actual|, over predictions with an actual value. Groups average their models\' values, because models predict in different units.'],
  ['Alert', 'A prediction the model flagged as an anomaly.', 'anomaly_flag = true. Business outcomes count the same alerts per hour as incidents predicted.'],
  ['Incident', 'One event the models caught.', 'Consecutive hours with alerts on the same model.'],
  ['Alert precision / false alarm rate', 'Whether alerts can be trusted.', `Confirmed incidents ÷ alerts, and false positives ÷ alerts. Tuning is suggested above ${rPct(r.fp)} false alarms (business rule false_positive_rate_threshold).`],
  ['Estimated savings and downtime avoided', 'The value attributed to the models.', 'As recorded in the business outcomes, in US dollars and hours. Estimates, not audited figures; there is no full model cost (only synthetic serving cost), so no ROI.'],
  ['Yield improvement', 'Process yield gained.', 'Average percentage points per hour, for reactor and furnace models only (other asset types do not measure yield).'],
  ['Scoring latency', 'How fast models answer.', 'Average milliseconds per prediction; p95 is the time 95% of predictions beat.'],
  ['Action queues', 'Where to put effort this week.', `Each model sits in the first queue that applies: drifting (review and plan retraining), then low confidence (investigate), then more than ${rPct(r.fp)} false alarms (tune alerts), then alerts recorded as Ignored (close the loop).`],
  // Operations figures: built on synthetic serving, cost, drift, retraining and governance data.
  ['SLA met (uptime)', 'Whether the models were there when called. Synthetic demo data.', `Endpoint-minutes available ÷ all endpoint-minutes, month to date, against the ${(r.sla * 100).toFixed(1)}% target (business rule sla_uptime_target).`],
  ['Error budget and burn rate', 'How much downtime the month can still absorb.', `Budget = the downtime the ${(r.sla * 100).toFixed(1)}% target allows for the whole month. Burn rate = share of budget used ÷ share of the month gone; above 1× is too fast.`],
  ['Month-end outlook', 'Where the month lands if nothing changes.', `Month-to-date downtime plus the last ${r.runRate} days' daily downtime for each remaining day. Likely when that rate is within 80% of what the remaining budget allows per day, Possible up to 100%, otherwise Unlikely. A projection, not a forecast of record.`],
  ['Predictions served vs forecast', 'Whether demand matched the capacity plan.', 'Requests served month to date ÷ requests forecast for the same days. Synthetic demo data.'],
  ['Latency SLO', 'Whether real-time models answer fast enough.', `p95 response time of ${r.slo} ms or less for real-time endpoints (business rule latency_slo_ms); batch endpoints have none.`],
  ['Fleet tiers', 'One label per model, worst first.', `Breaching SLO (real-time, over ${r.slo} ms on the latest day), Degrading (data drift on ${r.psiN}+ features, drifting in the monitoring data, or error up ${rPct(r.accWatch)}+), Stale (trained over ${r.stale} days ago), Watch (1–${r.psiN - 1} drifted features, low confidence or retraining overdue), else Healthy.`],
  ['Fleet health score', 'The fleet in one number.', 'Each model starts at 100 and loses points by tier (Breaching SLO 60, Degrading 40, Stale 25, Watch 10); the fleet score is the average.'],
  ['High-risk models', 'Where a failure would hurt most.', 'Criticality High, and Breaching SLO, Degrading or Stale.'],
  ['Feature drift (PSI)', 'Which inputs moved.', `Population stability index per input feature on the latest day; over ${rDec(r.psi)} is significant (business rule psi_drift_threshold).`],
  ['Accuracy change', 'Whether models are getting worse.', `Change in error (as a share of actual values) from the first to the latest day of the monitoring data. Error up ${rPct(r.accWatch)} or more = degrading; ${rPct(r.accRollback)} or more = roll back.`],
  ['Retraining overdue / stale', 'Models running on old training data.', `Overdue: more than ${r.overdue} days past the planned cadence. Stale: trained over ${r.stale} days ago.`],
  ['Governance gap', 'Models out of line with model-risk policy.', `Model card older than ${r.cardAge} days, or bias audit past its due date.`],
  ['Cost per 1K inferences', 'What serving costs.', 'Serving cost month to date ÷ requests × 1,000, US dollars. Synthetic demo data.'],
  ['Upside', 'What fixing things is worth a month.', 'Value recovery: a quarter of the value at stake of degrading or SLO-breaching models. Cost saving: half the serving cost of under-used GPU endpoints, all of it for idle stale ones. Estimates on stated assumptions (gold.business_rules_config).'],
  ['Recorded cause', 'Why an issue happened, when it is known.', 'A pipeline or platform event recorded against the affected models (synthetic demo data). Shown only when recorded; never inferred.'],
];
function openKpiDict() {
  document.getElementById('kpiDictBody').innerHTML = `<p class="score-reason">Every figure comes from certified views of the model data; no AI computes them. Thresholds are stored with the data (gold.business_rules_config), with the reason for each.</p>
    <table class="mini kpi-table"><thead><tr><th>Metric</th><th>Why it matters</th><th>How it is calculated</th></tr></thead><tbody>
    ${kpiDict(RULES).map(([m, w, c]) => `<tr><td><b>${hEsc(m)}</b></td><td>${hEsc(w)}</td><td>${hEsc(c)}</td></tr>`).join('')}</tbody></table>`;
  document.getElementById('kpiDict').showModal();
}
['kpiDictBtn', 'kpiDictBtn2'].forEach(id => document.getElementById(id)?.addEventListener('click', openKpiDict));
document.getElementById('kpiDictClose').addEventListener('click', () => document.getElementById('kpiDict').close());
document.getElementById('kpiDict').addEventListener('click', (e) => { if (e.target.id === 'kpiDict') e.target.close(); });
document.getElementById('kpiMoreBtn').addEventListener('click', (e) => {
  const sec = document.getElementById('execKpis2');
  sec.hidden = !sec.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!sec.hidden));
  e.currentTarget.textContent = sec.hidden ? 'Show 10 more metrics' : 'Show fewer metrics';
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
  if (s && s.rules) RULES = rulesOf(s);
  run(() => renderHero(s, {}));
  const o = (await overviewReq) || {};
  const steps = [
    () => renderHero(s, o), () => renderExecSummary(s, o),
    () => renderFleetHealth(s, o), () => renderTiers(o), () => renderHealthBu(o), () => renderAssets(s, o),
    () => renderIssues(s, o),
    () => renderActionCenter(s, o), () => renderAttention(o),
    () => renderValue(s, o), () => renderIncidents(o), () => renderValueBu(s, o), () => renderValueCrit(o),
    () => renderUpside(o), () => renderTopTargets(o),
  ];
  for (const fn of steps) { run(fn); await nextFrame(); }
  // Then the other tabs load in the background while the browser is idle, so they open
  // instantly. The Command Center always comes first; the Assistant loads its own when idle.
  (window.requestIdleCallback || (f => setTimeout(f, 1000)))(() => {
    if (window.loadExplorer) window.loadExplorer();
    if (window.loadMonitoring) window.loadMonitoring({ maxAgeMs: 60_000 });
    // Observability's own areas too, so every pane is ready when opened (each refreshes again on open).
    if (window.loadEvals) window.loadEvals();
    if (window.loadResponsibleAi) window.loadResponsibleAi();
    if (window.loadCost) window.loadCost();
  }, { timeout: 3000 });
}

/** "1,234 of 1,886", or just the first number when the second isn't known yet. */
const ofN = (a, b) => (num(a) === null ? '—' : num(b) === null ? count(a) : `${count(a)} of ${count(b)}`);
const rulesOf = o => {
  const r = o.rules || {};
  return { score: num(r.low_confidence_score) ?? 0.6, share: num(r.low_confidence_model_share) ?? 0.2,
    drift: num(r.drift_alert_threshold) ?? 0.3, fp: num(r.false_positive_rate_threshold) ?? 0.25,
    sla: num(r.sla_uptime_target) ?? 0.999, slo: num(r.latency_slo_ms) ?? 200, psi: num(r.psi_drift_threshold) ?? 0.25,
    psiN: num(r.psi_drift_feature_count) ?? 3, accWatch: num(r.accuracy_drop_watch) ?? 0.05, accRollback: num(r.accuracy_drop_rollback) ?? 0.1,
    stale: num(r.stale_model_days) ?? 90, overdue: num(r.retrain_overdue_days) ?? 14, cardAge: num(r.model_card_max_age_days) ?? 180,
    gpuUtil: num(r.gpu_low_utilization_pct) ?? 25, idle: num(r.idle_requests_per_day) ?? 1000, runRate: num(r.outlook_run_rate_days) ?? 3 };
};
/** 494.9M, 12.3K: request volumes. */
const big = v => { const n = num(v); if (n === null) return '—'; const a = Math.abs(n);
  return a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : count(n); };
/** 99.87%: uptime needs two decimals to show the gap to 99.9%. */
const upt = v => (num(v) === null ? '—' : (num(v) * 100).toFixed(2) + '%');
/** "+14%" / "−4%". */
const signed = (v, d = 0) => (num(v) === null ? '—' : (num(v) > 0 ? '+' : num(v) < 0 ? '−' : '') + Math.abs(num(v) * 100).toFixed(d) + '%');
const SYNTH = '<span class="synth-tag" title="Serving, SLA, cost, feature drift, retraining, promotions, governance and recorded causes are synthetic demo data">synthetic</span>';
const plural = (n, one, many) => (Math.round(num(n)) === 1 ? one : many);

const LIKELY_TONE = { Likely: 'good', Possible: 'warn', Unlikely: 'bad' };

/**
 * 1. Are we on track this month? The serving SLA month to date against its target, volume
 * against forecast, the month-end outlook, the error budget, promotions in flight and the
 * latency SLO callout (qry_cc_ops_month; synthetic serving data).
 */
function renderHero(s, o) {
  document.getElementById('heroGreeting').textContent = greeting();
  const m = o.ops;
  if (!m) return;   // the overview hasn't arrived yet: the loading line stays
  const r = rulesOf(o);
  const up = num(m.uptime_mtd), target = num(m.sla_uptime_target), proj = num(m.projected_uptime);
  const days = num(m.days_left), likely = m.outlook_likelihood;
  const verdict = likely === 'Likely' ? 'likely to meet the target' : likely === 'Possible' ? 'it could still meet the target, with no margin' : 'unlikely to meet the target';
  document.getElementById('heroSub').innerHTML =
    `Serving uptime is <b>${upt(up)}</b> month to date against the <b>${upt(target)}</b> target, with <b>${count(days)}</b> ${plural(days, 'day', 'days')} left` +
    (up >= target ? '. ' : ', so the month is behind. ') +
    `If the downtime of the last ${count(r.runRate)} days continues, the month ends near <b>${upt(proj)}</b>: <b>${hEsc(verdict)}</b>.`;
  const used = 1 - num(m.error_budget_remaining_share), elapsed = num(m.days_elapsed) / num(m.days_in_month);
  const burn = num(m.error_budget_burn_rate);
  const late = num(m.latency_breach_models), lateWeek = num(m.latency_breach_week_models), rt = num(m.real_time_models);
  document.getElementById('heroProgress').innerHTML = `
    <div class="budget-bar" role="img" aria-label="Error budget used ${pct(used, 0)}, month elapsed ${pct(elapsed, 0)}">
      <span class="budget-used ${burn > 1 ? 't-bad' : 't-good'}" style="width:${Math.min(100, used * 100).toFixed(1)}%"></span>
      <span class="budget-mark" style="left:${(elapsed * 100).toFixed(1)}%" title="Share of the month gone"></span></div>
    <div class="hp-legend"><span>Error budget used <b>${pct(used, 0)}</b> · month gone ${pct(elapsed, 0)} (marker)</span><span>burning at <b>${dec(burn, 1)}×</b> the pace the month allows</span></div>` +
    (late || lateWeek ? `<div class="hero-callout">${icon('clock', 'ico-sm')}<span><b>${pct(num(m.latency_breach_share), 0)}</b> of real-time models (${ofN(late, rt)}) are missing the ${count(r.slo)} ms latency SLO on the latest day; ${count(lateWeek)} breached it this week.</span>${viewBtn('ops_latency_week', 'View', '', 'Real-time models over the latency SLO this week', true)}</div>` : '');
  document.getElementById('heroStats').innerHTML = [
    ['SLA met (uptime)', upt(up), `target ${upt(target)} · ${count(days)} days left`, 'shield'],
    ['Predictions served', big(m.requests_mtd), `${pct(m.requests_vs_forecast, 0)} of the ${big(m.forecast_requests_mtd)} forecast`, 'pulse'],
    ['Month-end outlook', upt(proj), `<span class="lk lk-${LIKELY_TONE[likely] || 'warn'}">${hEsc(likely)}</span> at the last ${count(r.runRate)} days' rate`, 'target'],
    ['Error budget left', pct(m.error_budget_remaining_share, 0), `${count(m.downtime_mtd_minutes)} of ${count(m.error_budget_minutes)} minutes used · burn ${dec(burn, 1)}×`, 'clock'],
    ['Promotions in flight', count(m.promotions_in_flight), `${count(m.promotions_on_track)} on track · ${count(m.promotions_at_risk)} at risk · ${count(m.promotions_blocked)} blocked`, 'check', 'wide'],
  ].map(([l, v, sub, ic, cls]) => `<div class="hs${cls ? ' ' + cls : ''}"><div class="hs-ico">${icon(ic)}</div><div><div class="hs-l">${l}</div><div class="hs-v">${v}</div><div class="hs-s">${sub}</div></div></div>`).join('');
  // Load time from the warehouse is UTC; shown in the viewer's local time.
  const loaded = (v) => { const d = v ? new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z')) : null; return d && !isNaN(d) ? d.toLocaleString() : v; };
  document.getElementById('heroNote').innerHTML =
    `<div><b>Month to date:</b> ${when(m.month_from)} to ${when(m.month_to)}. <b>Model monitoring:</b> ${when(s.window_from)} to ${when(s.as_of)} (${count(s.days_in_window)} days); health and accuracy are judged on its latest day.</div>` +
    `<div class="hero-synth">${SYNTH} Serving, SLA, cost, promotions and governance figures are synthetic demo data.</div>` +
    (s.data_refreshed_at ? `<div class="hero-refresh">Data loaded on ${loaded(s.data_refreshed_at)}</div>` : '');
}

/** Models per fleet tier, by name: { 'Breaching SLO': 3, Degrading: 8, ... }. */
const tierCounts = o => Object.fromEntries((o.tiers || []).map(t => [t.fleet_tier, num(t.models) || 0]));
/** "roll back 1 model and restore capacity on 3 endpoints": a horizon's actions in a few words. */
const SHORT_ACTION = {
  ops_rollback: n => `roll back ${count(n)} ${plural(n, 'model', 'models')}`,
  ops_latency: n => `restore capacity on ${count(n)} ${plural(n, 'endpoint', 'endpoints')} over the latency SLO`,
  ops_data_drift: n => `retrain ${count(n)} ${plural(n, 'model', 'models')} with data drift`,
  ops_accuracy_watch: n => `retrain ${count(n)} ${plural(n, 'model', 'models')} losing accuracy`,
  ops_retrain_overdue: n => `clear a retraining backlog of ${count(n)}`,
  queue_confidence: n => `investigate ${count(n)} low-confidence ${plural(n, 'model', 'models')}`,
  ops_stale: n => `retire or retrain ${count(n)} stale ${plural(n, 'model', 'models')}`,
  ops_low_utilization: n => `right-size ${count(n)} under-used ${plural(n, 'GPU', 'GPUs')}`,
  ops_governance_gap: n => `close ${count(n)} governance ${plural(n, 'gap', 'gaps')}`,
};
const horizonWords = (o, h) => (o.opsActions || []).filter(a => a.horizon === h)
  .map(a => (SHORT_ACTION[a.list_key] || (n => `${a.action.toLowerCase()} (${count(n)})`))(a.models));
const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const upsideTotals = o => (o.upside || []).reduce((acc, u) => {
  const k = u.lever_kind === 'Value recovery' ? 'value' : 'cost';
  acc[k] += num(u.potential_saving_usd_month) || 0; acc[k + 'Models'] += num(u.models) || 0; return acc;
}, { value: 0, cost: 0, valueModels: 0, costModels: 0 });

/**
 * Executive summary: a bottom line, then one labelled line per chapter (where we stand, the
 * fleet, what's hurting us, this week, extra upside). Written from the same certified figures
 * as the chapters, so it can't drift from them. Each line jumps to its chapter.
 */
function renderExecSummary(s, o) {
  const a = o.actions, m = o.ops;
  if (!a || !m) return;   // the overview hasn't arrived yet: the skeleton stays
  const tc = tierCounts(o);
  const issues = o.issues || [];
  const up = num(m.uptime_mtd), target = num(m.sla_uptime_target);
  const today = horizonWords(o, 'TODAY'), week = horizonWords(o, 'THIS WEEK');
  const u = upsideTotals(o);
  const behind = up < target;
  document.getElementById('execSumBottom').innerHTML = `<span class="es-bl">Bottom line</span>${hEsc(
    `${behind ? 'Behind' : 'Meeting'} the ${upt(target)} serving SLA month to date (${upt(up)}), ` +
    `${m.outlook_likelihood === 'Likely' ? (behind ? 'and likely to recover by month end' : 'and likely to stay there') : m.outlook_likelihood === 'Possible' ? 'with no margin left for the month' : 'and unlikely to meet it this month'}` +
    `${today.length ? `; today, ${andList(today)}` : ''}${num(m.degrading_models) ? `, then retrain the ${count(m.degrading_models)} degrading ${plural(m.degrading_models, 'model', 'models')} this week` : ''}.`)}`;
  const rows = [
    ['ch1', 'Where we stand', `Uptime ${upt(up)} against the ${upt(target)} target with ${count(m.days_left)} days left; ${big(m.requests_mtd)} predictions served (${pct(m.requests_vs_forecast, 0)} of forecast); ` +
      `${pct(m.error_budget_remaining_share, 0)} of the error budget left, burning at ${dec(m.error_budget_burn_rate, 1)}×; ${ofN(m.promotions_on_track, m.promotions_in_flight)} promotions on track.`,
      upt(up), 'uptime month to date', behind ? 'warn' : 'good'],
    ['ch2', 'The fleet', `${count(m.models_in_production)} models in production with a health score of ${count(m.fleet_health_score)}/100: ${count(tc.Healthy)} healthy, ${count(tc.Watch)} on watch, ` +
      `${count(tc.Degrading)} degrading, ${count(tc.Stale)} stale and ${count(tc['Breaching SLO'])} breaching the SLO; ${count(m.high_risk_models)} high-risk. ${CUR}${dec(m.cost_per_1k_inferences_usd, 3)} per 1,000 inferences.`,
      count(m.fleet_health_score), 'fleet health score', num(m.fleet_health_score) >= 90 ? 'good' : 'warn'],
    ['ch3', "What's hurting us", issues.length ? issues.slice(0, 2).map(i => `${i.headline} (${i.severity.toLowerCase()})`).join('; ') + (issues.length > 2 ? `; ${issues.length - 2} more ${plural(issues.length - 2, 'issue', 'issues')} ranked below.` : '.')
      : 'No operational issue is open.',
      count(issues.filter(i => i.severity !== 'Medium').length), 'critical or high issues', issues.some(i => i.severity === 'Critical') ? 'bad' : 'warn'],
    ['ch4', 'This week', `${today.length ? `Today: ${andList(today)}. ` : ''}${week.length ? `This week: ${andList(week)}.` : ''}`,
      count((o.opsActions || []).filter(x => x.horizon === 'TODAY').reduce((n, x) => n + (num(x.models) || 0), 0)), 'models to act on today', today.length ? 'bad' : 'good'],
    ['ch5', 'Extra upside', `About ${money(u.value + u.cost)} a month: ${money(u.value)} by fixing ${count(u.valueModels)} degrading or SLO-breaching models and ${money(u.cost)} by right-sizing or retiring ${count(u.costModels)} endpoints; ` +
      `on top of ${money(s.cost_savings_usd)} already saved across ${count(s.incidents)} incidents.`,
      money(u.value + u.cost), 'a month (estimate)', 'brand'],
  ];
  document.getElementById('execSumList').innerHTML = rows.map(([id, label, line, fig, figLabel, t]) => `
    <li><a class="es-row" href="#${id}">
      <span class="es-n">${icon({ ch1: 'shield', ch2: 'pulse', ch3: 'alert', ch4: 'check', ch5: 'cash' }[id], 'ico-sm')}</span>
      <span class="es-text"><span class="es-label">${hEsc(label)}</span><span class="es-line">${hEsc(line)}</span></span>
      <span class="es-fig es-${t}"><b>${fig}</b><small>${hEsc(figLabel)}</small></span>
    </a></li>`).join('');
}

/** 2. How healthy is the fleet? Fleet cards and tiers, then health by business unit and asset type. */
function renderFleetHealth(s, o) {
  const r = rulesOf(o);
  const m = o.ops || {};
  const tc = tierCounts(o);
  const hca = num(s.high_criticality_needing_attention);
  setTake('ch2Take', (o.ops ? `Fleet health score <b>${count(m.fleet_health_score)}</b>/100: <b>${count(tc.Healthy)}</b> of ${count(m.models_in_production)} models are healthy, <b>${count(tc.Watch)}</b> on watch, <b>${count(tc.Degrading)}</b> degrading, <b>${count(tc.Stale)}</b> stale and <b>${count(tc['Breaching SLO'])}</b> breaching the SLO. ` : '') +
    `On the monitoring data, <b>${ofN(s.models_needing_attention, s.models)}</b> models need attention: <b>${count(s.drifting_models)}</b> drifting and <b>${count(s.low_confidence_only_models)}</b> with low confidence` +
    (hca ? `, including <b>${count(hca)}</b> business-critical ${plural(hca, 'model', 'models')}` : '') + '.');
  const card = (ic, label, value, sub, why, t, view = '') => `
    <div class="xkpi${t ? ' x-' + t : ''}" title="${hEsc(why)}">
      <div class="xkpi-top">${icon(ic, 'ico-sm')}<span>${label}</span></div>
      <div class="xkpi-v">${value}</div>
      <div class="xkpi-s">${sub}</div>
      <div class="xkpi-why">${hEsc(why)}</div>${view}
    </div>`;
  const rt = num(m.real_time_models), mp = num(m.models_in_production);
  document.getElementById('execKpis').innerHTML = o.ops ? [
    card('pulse', 'Models in production', count(mp), `${count(rt)} real-time · ${count(mp - rt)} batch ${SYNTH}`, 'Every model with a serving endpoint', null,
      viewBtn('ops_all', 'View models', '', 'Models in production', true)),
    card('shield', 'Fleet health score', `${count(m.fleet_health_score)}<small>/100</small>`, 'average model score; points lost by tier', 'Breaching SLO −60, Degrading −40, Stale −25, Watch −10',
      num(m.fleet_health_score) < 80 ? 'bad' : num(m.fleet_health_score) < 90 ? 'warn' : null),
    card('alert', 'High-risk models', count(m.high_risk_models), 'High criticality and breaching, degrading or stale', 'Where a failure would hurt most',
      num(m.high_risk_models) ? 'bad' : null, viewBtn('ops_high_risk', 'View models', '', 'High-risk models', true)),
    card('slip', 'Models degrading', count(m.degrading_models), `data drift on ${count(r.psiN)}+ features, drifting, or error up ${rPct(r.accWatch)}+`, 'Models whose outputs are getting worse',
      num(m.degrading_models) ? 'warn' : null, viewBtn('tier_degrading', 'View models', '', 'Degrading models', true)),
    card('cash', 'Cost per 1K inferences', `${CUR}${dec(m.cost_per_1k_inferences_usd, 3)}`, `${money(m.cost_mtd_usd)} month to date · ${money(m.monthly_cost_usd)} over 30 days ${SYNTH}`, 'Serving cost ÷ requests × 1,000'),
  ].join('') : '';
  document.getElementById('execKpis2').innerHTML = [
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
    card('target', 'Average confidence', pct(s.avg_confidence, 1), `${pct(s.low_confidence_share, 1)} of predictions below ${pct(r.score, 0)} (${ofN(s.low_confidence_predictions, s.predictions)})`, 'How sure the models are of their outputs'),
    card('bell', 'Alert precision', pct(s.alert_precision, 0), `${ofN(s.confirmed_incidents, s.alerts)} alerts confirmed as real incidents`, 'Whether alerts can be trusted'),
    card('alert', 'False alarm rate', pct(s.false_positive_rate, 0), `${ofN(s.false_positives, s.alerts)} alerts were not real`, 'Alerts that cost attention without an incident', num(s.false_positive_rate) > r.fp ? 'warn' : null,
      viewBtn('high_fp', 'View models', '', 'Models with more than 1 in 4 false alarms', true)),
    card('clock', 'Scoring latency', num(s.avg_latency_ms) === null ? '—' : `${num(s.avg_latency_ms).toFixed(0)} ms`, `average per prediction · slowest model's p95 ${count(s.worst_p95_latency_ms)} ms`, 'How fast models answer'),
    card('bell', 'Models that raised alerts', count(s.models_with_alerts), `${count(s.incidents)} incidents · ${count(s.alerts)} alerts in total`, 'Models that flagged anomalies in the window', null,
      viewBtn('with_alerts', 'View models', '', 'Models that raised alerts', true)),
  ].join('');
}

/** 2. (continued) The fleet by tier: models, cost, value at stake and accuracy change. */
const TIER_COLORS = { 'Breaching SLO': '#DC2626', Degrading: '#EA580C', Stale: '#64748B', Watch: '#D97706', Healthy: '#0E8F80' };
const TIER_LIST = { 'Breaching SLO': 'tier_breaching', Degrading: 'tier_degrading', Stale: 'tier_stale', Watch: 'tier_watch', Healthy: 'tier_healthy' };
function renderTiers(o) {
  const rows = o.tiers || [];
  if (!rows.length) return;
  const r = rulesOf(o);
  const total = rows.reduce((a, x) => a + (num(x.models) || 0), 0) || 1;
  const stack = `<div class="stack" role="img" aria-label="${hEsc(rows.map(x => `${x.fleet_tier}: ${count(x.models)}`).join(', '))}">${rows.filter(x => num(x.models)).map(x =>
    `<span style="width:${(100 * num(x.models) / total).toFixed(2)}%;background:${TIER_COLORS[x.fleet_tier]}" title="${hEsc(x.fleet_tier)}: ${count(x.models)} models">${num(x.models) / total > 0.05 ? count(x.models) : ''}</span>`).join('')}</div>`;
  const body = stack + `<div class="table-scroll flat" style="margin-top:12px"><table class="mini risk-table"><thead><tr><th>Tier</th><th>Models</th><th>Share</th><th>Monthly cost</th><th>Value at stake / month</th><th>Accuracy change</th><th></th></tr></thead><tbody>
    ${rows.map(x => `<tr><td><i class="cnx-dot" style="background:${TIER_COLORS[x.fleet_tier]}"></i> <b>${hEsc(x.fleet_tier)}</b></td><td>${count(x.models)}</td><td>${pct(x.model_share, 0)}</td>
      <td>${money(x.monthly_cost_usd)}</td><td>${money(x.value_at_stake_usd_month)}</td>
      <td>${num(x.avg_error_change) === null ? '<span class="muted">—</span>' : `<span class="${num(x.avg_error_change) > 0.01 ? 'neg' : ''}">${signed(-num(x.avg_error_change), 1)}</span>`}</td>
      <td>${num(x.models) ? viewBtn(TIER_LIST[x.fleet_tier], 'View', '', `${x.fleet_tier} models`, true) : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="panel-note">Each model sits in the first tier that applies: Breaching SLO (real-time, p95 over ${count(r.slo)} ms on the latest day), Degrading, Stale (trained over ${count(r.stale)} days ago), Watch, Healthy. Accuracy change is the average change in error from the first to the latest monitoring day, shown as accuracy (negative = worse). Cost and value at stake ${SYNTH}.</div>`;
  panel('pnlTiers', 'The fleet by tier', 'Where the models, the serving cost and the value at stake sit',
    { q: 'How is the model fleet distributed across health tiers, and what do the breaching and degrading models cost us?', mode: 'agent' }, body);
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

/**
 * 3. What's hurting us? The operations issues ranked in gold (qry_cc_issues: severity, headline,
 * evidence and the recorded cause), then the monitoring-data issues they don't already cover
 * (low confidence, false alarms, unanswered alerts), most severe first.
 */
const ISSUE_ICON = { data_drift: 'slip', latency: 'clock', accuracy: 'target', retrain_backlog: 'gap', governance: 'shield', stale: 'clock' };
const SEV_ORDER = { Critical: 1, High: 2, Medium: 3 };
function renderIssues(s, o) {
  const r = rulesOf(o);
  const att = o.attention || [];
  const lowConf = att.filter(m => m.health_status === 'Low confidence');
  const hcaLow = lowConf.filter(m => m.criticality === 'High');
  const worstFp = (o.incidents || []).slice().sort((a, b) => num(b.false_positive_rate) - num(a.false_positive_rate))[0];
  const unanswered = (o.incidents || []).filter(i => num(i.unanswered_alerts) > 0);
  const names = list => list.map(m => m.model_name).join(', ');
  const ops = (o.issues || []).map(i => ({
    sev: i.severity, ic: ISSUE_ICON[i.issue_key] || 'alert', view: [i.list_key, `View ${count(i.models)} ${plural(i.models, 'model', 'models')}`],
    title: i.headline, metric: `${count(i.models)} ${plural(i.models, 'model', 'models')}`,
    body: i.evidence + (i.issue_key === 'data_drift' && num(s.drifting_models)
      ? `. In the monitoring data, their drift score rose from ${dec(s.drifting_first_avg_drift)} to ${dec(s.drifting_latest_avg_drift)}.` : '.'),
    cause: i.recorded_cause === 'No recorded cause' ? null : i.recorded_cause,
    coverage: num(i.models_with_recorded_cause) < num(i.models) && num(i.models_with_recorded_cause) ? `recorded for ${ofN(i.models_with_recorded_cause, i.models)} models` : '',
    q: i.ask_question, synth: true,
  }));
  const source = [
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
    unanswered.length && { sev: 'Medium', ic: 'clock', view: ['unanswered', 'View the model'],
      title: `${count(s.unanswered_alerts)} alerts went unanswered`, metric: `${count(s.unanswered_alerts)} alerts`,
      body: unanswered.map(i => `On ${i.model_name} (${i.site_name}), the incident from ${when(i.incident_start, false)} had ${count(i.unanswered_alerts)} alerts recorded as "Ignored"; responses: ${i.responses}.`).join(' '),
      check: 'That every alert reaches someone who acts on it, at any hour.',
      q: 'Which alerts were ignored or not acted on, and what happened in those incidents?' },
  ].filter(Boolean);
  // Gold ranks the operations issues; the monitoring issues slot in by severity (stable, so gold's order holds).
  const issues = [...ops, ...source].map((c, i) => ({ ...c, i })).sort((a, b) => (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]) || (a.i - b.i));
  const top = issues[0];
  setTake('ch3Take', issues.length
    ? `<b>${count(issues.length)}</b> issues, most severe first. The top one: <b>${hEsc(top.title)}</b>` +
      (top.cause ? `. Recorded cause: ${hEsc(top.cause.split('. ')[0].replace(/\.$/, ''))}.` : '.') +
      ` Causes are shown only where a pipeline or platform event is recorded against the models.`
    : 'Nothing is hurting the fleet: every model is healthy and alerts are reliable.');
  document.getElementById('issues').innerHTML = issues.map((c, i) => `
    <div class="prio issue sev-${c.sev.toLowerCase()}">
      <div class="prio-top"><span class="prio-rank">${i + 1}</span><span class="sev-tag">${c.sev}</span>${c.synth ? SYNTH : ''}<span class="prio-metric">${c.metric}</span></div>
      <div class="prio-title">${icon(c.ic, 'ico-sm')} ${hEsc(c.title)}</div>
      <div class="prio-body">${hEsc(c.body)}</div>
      ${c.synth
        ? `<div class="issue-driver"><b>Recorded cause:</b> ${c.cause ? hEsc(c.cause) + (c.coverage ? ` <span class="muted">(${hEsc(c.coverage)})</span>` : '') : '<span class="muted">none recorded in the pipeline log</span>'}</div>`
        : `<div class="issue-driver"><b>What to check:</b> ${hEsc(c.check)}</div>`}
      <div class="card-btns">${viewBtn(c.view[0], c.view[1], c.view[2] || '', c.title)}${askBtn(c.q, 'agent', 'Ask Lens why')}</div>
    </div>`).join('') || '<div class="empty-note">Nothing is degrading: every model is healthy and alerts are reliable.</div>';
}

/**
 * 4. What should we do, and when? The prioritised actions by horizon (qry_cc_ops_actions:
 * today, this week, this month), with the monitoring data's alert queues added to this week.
 */
const ACTION_ASK = {
  ops_rollback: 'Which models should we roll back to their previous version, and why?',
  ops_latency: 'Which real-time endpoints are over the latency SLO right now, and what is the recorded cause?',
  ops_data_drift: 'Which models have data drift, on which features, and what is the recorded cause?',
  ops_accuracy_watch: 'Which models are losing accuracy, and by how much?',
  ops_retrain_overdue: 'Which models are overdue for retraining, and what is blocking them?',
  queue_confidence: 'Which models have low confidence, how low, and which of them are business-critical?',
  ops_stale: 'Which models have not been retrained in over 90 days, and should we retire any?',
  ops_low_utilization: 'Which GPU endpoints are under-used, and what would right-sizing them save?',
  ops_governance_gap: 'Which models have governance gaps, and when is the review deadline?',
  queue_tune: 'Which models raise the most false alarms, and how many of their alerts were confirmed?',
  unanswered: 'Which alerts were ignored or not acted on, and what happened in those incidents?',
};
const HORIZONS = [['TODAY', 'Today', 'bad'], ['THIS WEEK', 'This week', 'warn'], ['THIS MONTH', 'This month', 'brand']];
function renderActionCenter(s, o) {
  const a = o.actions || {};
  const r = rulesOf(o);
  const items = (o.opsActions || []).map(x => ({ h: x.horizon, t: x.action, d: x.reason, n: num(x.models), list: x.list_key,
    value: num(x.value_at_stake_usd_month), synth: x.list_key !== 'queue_confidence' }));
  // The monitoring data's alert queues (not in the operations actions) belong to this week.
  if (num(a.tune_alert_models)) items.push({ h: 'THIS WEEK', t: 'Tune alert thresholds', d: `${ofN(a.tune_alert_false_positives, a.tune_alert_alerts)} of their alerts were false alarms (more than ${pct(r.fp, 0)})`, n: num(a.tune_alert_models), list: 'queue_tune' });
  if (num(a.unanswered_alert_models)) items.push({ h: 'THIS WEEK', t: 'Close the loop on unanswered alerts', d: `${count(a.unanswered_alert_hours)} alert ${plural(a.unanswered_alert_hours, 'hour', 'hours')} recorded as "Ignored" or with no response`, n: num(a.unanswered_alert_models), list: 'unanswered' });
  const words = HORIZONS.map(([h, label]) => [label, horizonWords(o, h)]).filter(([, w]) => w.length);
  setTake('ch4Take', words.map(([label, w]) => `<b>${label}:</b> ${hEsc(andList(w))}.`).join(' ') + ' A model can appear in more than one action.');
  document.getElementById('actionCenter').innerHTML = HORIZONS.map(([h, label, tone]) => {
    const list = items.filter(x => x.h === h);
    return `<div class="horizon t-${tone}">
      <div class="horizon-head"><span class="act-when">${label}</span><span class="muted">${count(list.reduce((n, x) => n + x.n, 0))} model actions</span></div>
      ${list.map(x => `<div class="h-item">
        <div class="h-top"><span class="h-n">${count(x.n)}</span><span class="h-t">${hEsc(x.t)}</span></div>
        <div class="act-d">${hEsc(x.d)}${x.value ? ` · ${money(x.value)} a month at stake` : ''}${x.synth ? ' ' + SYNTH : ''}</div>
        <div class="card-btns">${viewBtn(x.list, 'View models', '', x.t, true)}${askBtn(ACTION_ASK[x.list] || `What should we do about: ${x.t}?`, 'agent')}</div>
      </div>`).join('') || '<div class="empty-note">Nothing due.</div>'}
    </div>`;
  }).join('');
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
    (top && share !== null ? ` The value is concentrated: one incident, on ${hEsc(top.model_name)} at ${hEsc(top.site_name)}, is <b>${pct(share, 0)}</b> of it.` : '') +
    ((o.upside || []).length ? (u => ` Fixing and right-sizing the fleet is worth about <b>${money(u.value + u.cost)}</b> more a month (an estimate).`)(upsideTotals(o)) : ''));
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

/** 5. (continued) The upside: estimated monthly value by lever and by model family. */
const LEVER_LIST = { 'Fix latency': 'lever_fix_latency', Retrain: 'lever_retrain', Decommission: 'lever_decommission', 'Right-size GPU': 'lever_rightsize' };
function renderUpside(o) {
  const rows = o.upside || [];
  if (!rows.length) return;
  const sumBy = key => Object.values(rows.reduce((acc, u) => {
    const k = u[key];
    acc[k] = acc[k] || { name: k, kind: u.lever_kind, models: 0, saving: 0 };
    acc[k].models += num(u.models) || 0; acc[k].saving += num(u.potential_saving_usd_month) || 0;
    return acc;
  }, {})).sort((a, b) => b.saving - a.saving);
  const levers = sumBy('optimisation_lever'), families = sumBy('model_type');
  const max = Math.max(...levers.map(x => x.saving), 1);
  const u = upsideTotals(o);
  panel('pnlUpside', 'Extra upside, by lever', `About ${money(u.value + u.cost)} a month: ${money(u.value)} value recovery, ${money(u.cost)} cost saving ${SYNTH}`,
    { q: 'Where is the extra upside in the model fleet: what could we recover or save each month, by lever and model family?', mode: 'agent' },
    levers.map(x => bar(hEsc(x.name), x.saving, max, `${money(x.saving)} <span class="muted">a month</span>`, x.kind === 'Value recovery' ? 'good' : 'brand',
      `${hEsc(x.kind)} · ${count(x.models)} ${plural(x.models, 'model', 'models')} ${LEVER_LIST[x.name] ? viewBtn(LEVER_LIST[x.name], 'View', '', `${x.name}: models`, true) : ''}`)).join('') +
    `<div class="panel-note"><b>By model family:</b> ${families.map(f => `${hEsc(f.name)} ${money(f.saving)} (${count(f.models)})`).join(' · ')}.</div>` +
    '<div class="panel-note">Value recovery assumes fixing a degrading or SLO-breaching model recovers a quarter of its value at stake; cost saving is half the serving cost of an under-used GPU endpoint, or all of an idle stale one. Estimates, not commitments.</div>');
}

/** 5. (continued) The top optimisation targets, largest upside first. */
function renderTopTargets(o) {
  const rows = o.topTargets || [];
  if (!rows.length) return;
  const body = `<div class="table-scroll flat"><table class="nice"><thead><tr><th>#</th><th>Model</th><th>Tier</th><th>Lever</th><th>Upside / month</th></tr></thead><tbody>
    ${rows.map(x => `<tr><td>${count(x.optimisation_rank)}</td><td>${modelCell(x)} <span class="muted">· ${hEsc(x.model_type)}, ${hEsc(x.criticality)}</span></td>
      <td><i class="cnx-dot" style="background:${TIER_COLORS[x.fleet_tier] || '#94A3B8'}"></i> ${hEsc(x.fleet_tier)}</td><td>${hEsc(x.optimisation_lever)}</td>
      <td><b>${money(x.potential_saving_usd_month)}</b></td></tr>`).join('')}</tbody></table></div>`;
  panel('pnlTopTargets', `Top ${count(rows.length)} optimisation targets`, `The models where action is worth most ${viewBtn('ops_top_targets', 'View and export', '', 'Top optimisation targets', true)}`,
    { q: 'Which models are the top optimisation targets, and what lever applies to each?', mode: 'agent' }, body);
}

// ---------------------------------------------------------------- the models behind a figure
// Every card can show its models: the same rule as its number, at model level.
const listRules = r => ({
  all: 'Every model in the fleet.',
  healthy: 'Neither drifting nor low-confidence on the latest day.',
  attention: 'Drifting or low-confidence on the latest day.',
  drifting: `Average drift score of ${rDec(r.drift)} or more on the latest day.`,
  low_confidence: `At least ${rPct(r.share)} of predictions on the latest day below ${rPct(r.score)} confidence.`,
  high_crit_attention: 'Criticality High, and drifting or low-confidence.',
  high_criticality: 'Criticality High.',
  with_alerts: 'Raised at least one alert in the window.',
  high_fp: `More than ${rPct(r.fp)} of the model's alerts were false alarms.`,
  unanswered: 'At least one hour of alerts recorded as "Ignored" or with no response.',
  with_action: `Has a next step: drifting, low confidence, more than ${rPct(r.fp)} false alarms, or unanswered alerts (first that applies).`,
  queue_retrain: 'Queue 1: drifting. Review the input data and plan retraining.',
  queue_confidence: 'Queue 2: low confidence (and not drifting). Investigate inputs and calibration.',
  queue_tune: `Queue 3: more than ${rPct(r.fp)} false alarms (and healthy). Tune the alert threshold.`,
  business_unit: 'All models in this business unit.',
  business_unit_attention: 'Models in this business unit that are drifting or low-confidence.',
  asset: 'All models of this asset type.',
  criticality: 'All models with this criticality.',
  ops_all: 'Every model in production, worst tier first. Serving data is synthetic.',
  tier_breaching: `Breaching SLO: real-time endpoint with p95 latency over ${r.slo} ms on the latest day.`,
  tier_degrading: `Degrading: data drift on ${r.psiN}+ input features (PSI over ${rDec(r.psi)}), drifting in the monitoring data, or error up ${rPct(r.accWatch)} or more.`,
  tier_stale: `Stale: live version trained more than ${r.stale} days ago (and not breaching or degrading).`,
  tier_watch: `Watch: 1–${r.psiN - 1} drifted features, low confidence, or retraining more than ${r.overdue} days overdue.`,
  tier_healthy: 'Healthy: none of the above.',
  ops_high_risk: 'Criticality High, and breaching the SLO, degrading or stale.',
  ops_data_drift: `${r.psiN} or more input features with PSI over ${rDec(r.psi)} on the latest day.`,
  ops_latency: `Real-time endpoints with p95 latency over ${r.slo} ms on the latest day.`,
  ops_latency_week: `Real-time endpoints with p95 latency over ${r.slo} ms on any day in the last 7.`,
  ops_accuracy_drop: `Error up ${rPct(r.accWatch)} or more from the first to the latest monitoring day.`,
  ops_accuracy_watch: `Error up ${rPct(r.accWatch)} or more, under the ${rPct(r.accRollback)} rollback threshold, and no data drift.`,
  ops_rollback: `Error up ${rPct(r.accRollback)} or more: roll back to the previous version.`,
  ops_retrain_overdue: `More than ${r.overdue} days past the planned retraining cadence (not yet stale).`,
  ops_stale: `Trained more than ${r.stale} days ago.`,
  ops_governance_gap: `Model card older than ${r.cardAge} days, or bias audit past its due date.`,
  ops_low_utilization: `GPU endpoints averaging under ${r.gpuUtil}% utilisation over the last 7 days.`,
  ops_top_targets: 'The models with the largest estimated monthly upside.',
  lever_fix_latency: 'Lever Fix latency: breaching the latency SLO; upside is a quarter of the value at stake.',
  lever_retrain: 'Lever Retrain: degrading models; upside is a quarter of the value at stake.',
  lever_decommission: `Lever Decommission: stale and averaging under ${count(r.idle)} requests a day; upside is the whole serving cost.`,
  lever_rightsize: `Lever Right-size GPU: GPU under ${r.gpuUtil}% utilisation; upside is half the serving cost.`,
});
const viewBtn = (list, label, value = '', title = '', sm = false) =>
  `<button class="view-btn${sm ? ' sm' : ''}" data-models="${list}" data-value="${hEsc(value)}" data-title="${hEsc(title)}">${hEsc(label)}</button>`;
function openModels(list, value, title) {
  return showModelList({
    url: `/api/dashboard/models?list=${encodeURIComponent(list)}${value ? '&value=' + encodeURIComponent(value) : ''}`,
    title, rule: listRules(RULES)[list] || '', file: `lens-mlops-${list}${value ? '-' + value.replace(/\W+/g, '-').toLowerCase() : ''}`,
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
  if (d.kind === 'ops') return showOpsList(t, rows, title, rule, file);
  document.getElementById('acctSum').innerHTML = `<b>${count(t.models)}</b> ${plural(t.models, 'model', 'models')} · <b>${count(t.alerts)}</b> alerts (${count(t.confirmed_incidents)} confirmed) · ` +
    `<b>${money(t.cost_savings_usd)}</b> estimated savings · <b>${count(t.downtime_avoided_hours)}</b> hours of downtime avoided`;
  document.getElementById('acctBody').innerHTML = rows.length ? `<table class="nice"><thead><tr><th>Model</th><th>Business unit · site</th><th>Asset</th><th>Criticality</th><th>Health</th>
      <th>Confidence <span class="muted">(latest day)</span></th><th>Drift</th><th>Error</th><th>Alerts</th><th>Savings</th><th>Next step</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${modelCell(r)}</td>
      <td>${hEsc(r.business_unit)} <span class="muted">· ${hEsc(r.site_name)}</span></td><td>${hEsc(r.asset_type)}</td><td>${hEsc(r.criticality)}</td>
      <td>${healthTag(r.health_status)}</td>
      <td>${pct(r.latest_day_avg_confidence, 0)} <span class="muted">· ${pct(r.latest_day_low_confidence_share, 0)} below ${rPct(RULES.score)}</span></td>
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

/** What stands out about a model operationally, in a few words (operations lists). */
function opsSignal(x) {
  const r = RULES, out = [];
  if (x.serving_mode === 'real_time' && num(x.week_max_p95_latency_ms) > r.slo) out.push(`p95 ${count(x.latest_p95_latency_ms)} ms (worst ${count(x.week_max_p95_latency_ms)} this week)`);
  if (num(x.drifted_features)) out.push(`${count(x.drifted_features)} ${plural(x.drifted_features, 'feature', 'features')} over PSI ${rDec(r.psi)} (max ${dec(x.max_feature_psi)}): ${x.drifted_feature_names}`);
  if (num(x.error_change) !== null && Math.abs(num(x.error_change)) >= r.accWatch) out.push(`error ${signed(x.error_change)}`);
  if (num(x.days_since_trained) > r.stale) out.push(`trained ${count(x.days_since_trained)} days ago`);
  else if (num(x.days_since_trained) - num(x.retrain_cadence_days) > r.overdue) out.push(`${count(num(x.days_since_trained) - num(x.retrain_cadence_days))} days overdue for retraining`);
  if (num(x.governance_gap_flag)) out.push(`card ${when(x.model_card_updated, true)}, audit due ${when(x.next_audit_due, true)}`);
  if (x.compute_type === 'GPU' && num(x.week_avg_utilization_pct) < r.gpuUtil) out.push(`GPU ${count(x.week_avg_utilization_pct)}% used`);
  return out.join(' · ') || '—';
}
function showOpsList(t, rows, title, rule, file) {
  document.getElementById('acctSum').innerHTML = `<b>${count(t.models)}</b> ${plural(t.models, 'model', 'models')} · <b>${money(t.value_at_stake_usd_month)}</b> a month at stake · ` +
    `<b>${money(t.monthly_cost_usd)}</b> serving cost over 30 days${num(t.potential_saving_usd_month) ? ` · <b>${money(t.potential_saving_usd_month)}</b> a month upside` : ''} ${SYNTH}`;
  document.getElementById('acctBody').innerHTML = rows.length ? `<table class="nice"><thead><tr><th>Model</th><th>Business unit · site</th><th>Criticality</th><th>Tier</th>
      <th>Serving</th><th>Signal</th><th>Cost / 30 days</th><th>At stake / month</th><th>Lever</th><th>Recorded cause</th></tr></thead>
    <tbody>${rows.map(x => `<tr><td>${modelCell(x)}</td><td>${hEsc(x.business_unit)} <span class="muted">· ${hEsc(x.site_name)}</span></td><td>${hEsc(x.criticality)}</td>
      <td><i class="cnx-dot" style="background:${TIER_COLORS[x.fleet_tier] || '#94A3B8'}"></i> ${hEsc(x.fleet_tier)}</td>
      <td>${hEsc(x.serving_mode === 'real_time' ? 'Real-time' : 'Batch')} <span class="muted">· ${hEsc(x.compute_type)}</span></td>
      <td>${hEsc(opsSignal(x))}</td><td>${money(x.monthly_cost_usd)}</td><td>${money(x.value_at_stake_usd_month)}</td>
      <td>${x.optimisation_lever ? `${hEsc(x.optimisation_lever)} <span class="muted">· ${money(x.potential_saving_usd_month)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="cause-cell">${x.recorded_causes ? hEsc(x.recorded_causes) : '<span class="muted">none recorded</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-note">No models match.</div>';
  document.getElementById('acctCsv').disabled = !rows.length;
  document.getElementById('acctCsv').onclick = () => downloadCsv(file || 'lens-mlops-models', `# ${title}: ${rule || ''} (serving, cost, drift, retraining and governance columns are synthetic demo data)`,
    ['model_id', 'model_name', 'business_unit', 'site_name', 'criticality', 'model_type', 'fleet_tier', 'health_score', 'health_status', 'serving_mode', 'compute_type',
      'latest_p95_latency_ms', 'week_max_p95_latency_ms', 'drifted_features', 'max_feature_psi', 'drifted_feature_names', 'error_change', 'days_since_trained',
      'retrain_cadence_days', 'last_trained_date', 'model_card_updated', 'next_audit_due', 'week_avg_utilization_pct', 'monthly_cost_usd',
      'value_at_stake_usd_month', 'optimisation_lever', 'potential_saving_usd_month', 'recorded_causes'], rows);
}

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

if (!window.tabVisible || window.tabVisible('home')) loadHome().catch(err => {
  console.error('Command Center failed to load', err);
  document.getElementById('heroSub').textContent = 'Some figures could not be loaded. Please refresh the page.';
});
