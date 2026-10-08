let obsLoaded = false;
const obsCharts = {};
let obsDays = 30;
let obsRecent = [];
let obsFeedback = [];

const STAGE_COLORS = ['#1D4ED8', '#059669', '#D97706', '#9333EA', '#0E9384', '#4338CA', '#DC2626', '#64748B', '#EA580C', '#0891B2'];

/** Service principals (the smoke test, automation) log an ID instead of an email; show them as such. */
function userName(u) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(u || '')) ? 'Automated test' : String(u || '');
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function renderTimeline(timeline, total) {
  const stages = (timeline || []).filter(s => s.ms > 0);
  if (!stages.length) return '<div class="score-reason">No timing recorded for this question (asked before timings were added).</div>';
  const sum = stages.reduce((a, s) => a + s.ms, 0) || 1;
  const segs = stages.map((s, i) =>
    `<div class="stagebar-seg" style="width:${(s.ms / sum * 100).toFixed(2)}%;background:${STAGE_COLORS[i % STAGE_COLORS.length]}" title="${esc(s.stage)}: ${fmtMs(s.ms)}"></div>`).join('');
  const legend = stages.map((s, i) =>
    `<div class="stagebar-item"><span class="stagebar-dot" style="background:${STAGE_COLORS[i % STAGE_COLORS.length]}"></span>` +
    `<span class="sname">${esc(s.stage)}</span><span class="sms">${fmtMs(s.ms)}</span></div>`).join('');
  return `<div class="stagebar">${segs}</div><div class="stagebar-legend">${legend}</div>` +
    `<div class="stagebar-total">Total <b>${fmtMs(total)}</b></div>`;
}

function renderQueries(queries) {
  if (!queries || !queries.length) return '<div class="score-reason">No SQL was run for this question.</div>';
  return queries.map((q, i) => `
    <div class="query-item">
      <div class="query-head"><span class="query-no">${i + 1}</span><span class="query-title">${esc(q.title)}</span>
        <span class="chip neutral">${q.rows === null || q.rows === undefined ? 'rows —' : `${fmtNum(q.rows)} row${q.rows === 1 ? '' : 's'}`}</span></div>
      <div class="codebox">${esc(q.sql)}</div>
    </div>`).join('');
}

function faithChip(score) {
  if (score === null || score === undefined) return '<span class="chip neutral" title="Not judged">—</span>';
  const pct = Math.round(Number(score) * 100);
  const tone = pct >= 85 ? 'ok' : pct >= 70 ? 'cache' : 'bad';
  return `<span class="chip ${tone}">${pct}%</span>`;
}

const GUARD_LABELS = {
  pii: 'Personal data', profanity: 'Profanity / abuse', prompt_injection: 'Prompt injection', off_topic: 'Off-topic',
  causal_claim: 'Causal claim about an action', forecast: 'Forecast beyond the data', roi_claim: 'ROI figure', probability: 'Probability claim',
};
const guardLabel = c => GUARD_LABELS[c] || c;

function renderJudge(j) {
  if (!j) return '<div class="score-reason">Not judged (the faithfulness judge is off, sampled out, or the answer came before it was enabled).</div>';
  const n = j.numeric || {};
  const parts = [
    `<span class="retry-pill">Score ${j.score === null || j.score === undefined ? '—' : Math.round(j.score * 100) + '%'}${j.reused ? ' (from when the cached answer was generated)' : ''}</span>`,
    `<span class="retry-pill">Numbers found in the data: ${n.checked ? `${n.found}/${n.checked}` : 'no figures to check'}</span>`,
    j.llm ? `<span class="retry-pill">Judge ${esc(modelName(j.llm.model))}: ${Math.round(j.llm.score * 100)}%${j.llm.tokens ? ` · ${fmtNum(j.llm.tokens)} tokens` : ''}</span>` : '',
    ...(j.llm && j.llm.metrics ? ['relevance', 'completeness', 'safety'].filter(k => j.llm.metrics[k] !== null && j.llm.metrics[k] !== undefined)
      .map(k => `<span class="retry-pill">${k.charAt(0).toUpperCase() + k.slice(1)} ${Math.round(j.llm.metrics[k] * 100)}%</span>`) : []),
    j.llmError ? `<span class="retry-pill">Judge model error: ${esc(j.llmError)}</span>` : '',
  ].filter(Boolean).join('');
  const missing = (n.missing || []).length ? `<div class="score-reason">Figures not found in the results: ${esc(n.missing.join(', '))}</div>` : '';
  const reason = j.llm && j.llm.reason ? `<div class="score-reason">${esc(j.llm.reason)}</div>` : '';
  const claims = j.llm && j.llm.unsupported && j.llm.unsupported.length
    ? `<div class="score-reason">Unsupported claims:<ul>${j.llm.unsupported.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : '';
  return `<div class="retry-pills">${parts}</div>${reason}${missing}${claims}`;
}

/** Endpoint names as the models' own names ("databricks-gpt-oss-20b" -> "GPT-OSS 20B"). */
function modelName(m) {
  if (!m) return '';
  const known = { 'databricks-gpt-oss-20b': 'GPT-OSS 20B', 'databricks-gpt-oss-120b': 'GPT-OSS 120B', 'databricks-gte-large-en': 'GTE Large (English)',
    'databricks-meta-llama-3-1-8b-instruct': 'Llama 3.1 8B Instruct', 'databricks-meta-llama-3-3-70b-instruct': 'Llama 3.3 70B Instruct' };
  return known[m] || String(m).replace(/^databricks-/, '');
}

function renderTokens(tokens) {
  const rows = Object.entries(tokens || {});
  if (!rows.length) return '<div class="score-reason">No AI model calls for this question (the query engine doesn\'t report its own token counts).</div>';
  return `<table class="mini"><thead><tr><th>Step</th><th>Model</th><th>Calls</th><th>Input</th><th>Output</th></tr></thead><tbody>${rows.map(([f, e]) =>
    `<tr><td>${esc(featureLabel(f))}</td><td>${esc(modelName(e.model))}</td><td>${fmtNum(e.calls)}</td><td>${fmtNum(e.input)}</td><td>${fmtNum(e.output)}</td></tr>`).join('')}</tbody></table>`;
}

function renderGuardEvents(events) {
  if (!events || !events.length) return '<div class="score-reason">No guardrail checks fired.</div>';
  return `<div class="retry-pills">${events.map(e =>
    `<span class="retry-pill" title="${esc(e.detail || '')}">${e.stage}: ${esc(guardLabel(e.check))} → ${e.action} (${e.by})</span>`).join('')}</div>`;
}

function ratingChip(v) {
  if (v === 1) return '<span class="chip ok">👍 helpful</span>';
  if (v === -1) return '<span class="chip bad">👎 not helpful</span>';
  return '<span class="chip neutral">—</span>';
}

function renderAuditTrail() {
  const who = document.getElementById('obsUserFilter').value;
  const rows = who ? obsRecent.filter(e => e.user_email === who) : obsRecent;
  const tbody = document.querySelector('#recentTable tbody');
  tbody.innerHTML = '';
  rows.forEach(e => {
    const d = e.details || {};
    const tr = document.createElement('tr');
    tr.className = 'turn-row';
    const resultChip = e.guard_action === 'blocked' ? '<span class="chip cache" title="Stopped by a guardrail before reaching the query engine">blocked</span>'
      : e.success ? '<span class="chip ok">answered</span>'
      : `<span class="chip bad" title="${esc(e.error_message || '')}">failed</span>`;
    tr.innerHTML = `<td>${new Date(e.created_at).toLocaleString()}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(userName(e.user_email))}</td>
      <td><span class="badge ${e.mode === 'agent' ? 'amber' : 'green'}">${esc(modeName(e.mode))}</span></td>
      <td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.question)}">${esc(e.question)}</td>
      <td>${resultChip}</td><td>${ratingChip(e.feedback)}</td><td>${faithChip(e.faithfulness)}</td>
      <td>${e.from_cache ? `<span class="chip cache" title="Answered from the answer cache">⚡ ${fmtMs(e.latency_ms)}</span>` : fmtMs(e.latency_ms)}</td><td>▸</td>`;

    const detailTr = document.createElement('tr');
    detailTr.className = 'turn-detail-row';
    const td = document.createElement('td');
    td.colSpan = 9;
    const c = d.cache || null;
    const cacheFact = !c ? null
      : c.hit ? `Answered from cache (${c.match === 'semantic' && c.similarTo ? `similar question "${esc(c.similarTo.question.slice(0, 80))}", ${(c.similarTo.similarity * 100).toFixed(1)}% similar, ` : ''}${c.source === 'prewarm' ? 'pre-warmed suggested question' : 'earlier answer'}, generated ${new Date(c.generatedAt).toLocaleString()}${c.originalLatencyMs ? `, originally took ${fmtMs(c.originalLatencyMs)}` : ''})`
      : c.refreshed ? 'Refreshed: cache bypassed, answered live'
      : c.closest ? `Cache miss: closest cached question "${esc(c.closest.question.slice(0, 80))}" was ${(c.closest.similarity * 100).toFixed(1)}% similar${c.closest.sameDetails ? '' : ', with different key details'}${c.stored ? '; answered live and saved to the cache' : ''}`
      : c.stored ? 'Cache miss: answered live and saved to the cache'
      : 'Cache miss: answered live';
    const facts = [
      cacheFact,
      `Chat: ${esc(e.session_title || 'Untitled chat')}`,
      `SQL queries: ${(d.queries || []).length}`,
      `Charts: ${d.charts ?? 0}`,
      d.agentSteps != null ? `Agent steps: ${d.agentSteps}` : null,
      d.contextCarriedOver ? 'Context carried over from the other mode' : null,
      (d.sources || []).length ? `Data sources: ${esc(d.sources.join(', '))}` : null,
      d.followUps ? `Follow-ups suggested: ${d.followUps}` : null,
      d.platformHelp ? `Answered from the platform guide (${d.platformHelp.method === 'ai' ? 'AI model' : 'guide text'}): ${esc((d.platformHelp.sections || []).join(', '))}` : null,
      d.autoMode ? `Mode chosen by Auto (${d.autoMode.method === 'ai' ? 'AI classifier' : 'word rule'}): ${esc(d.autoMode.reason || '')}${d.autoMode.fallback ? ` · fell back to the rule: ${esc(d.autoMode.fallback)}` : ''}` : null,
      e.feedback_reason ? `Feedback: ${esc(e.feedback_reason.replace(/_/g, ' '))}${e.feedback_comment ? ` ("${esc(e.feedback_comment)}")` : ''}` : null,
      d.genieMessageId ? `Message: ${esc(d.genieMessageId)}` : null,
    ].filter(Boolean);
    td.innerHTML = `
      <div class="turn-detail">
        <div class="turn-detail-grid">
          <div class="turn-detail-block">
            <div class="lab">Answer</div>
            <div class="answer-box">${esc(stripCitations(d.answerPreview || (e.success ? '—' : 'No answer was returned.'))
              .replace(/\*\*/g, '').replace(/\[\[chart:[^\]]+\]\]/g, '[chart]').replace(/\\([[\]])/g, '$1'))}</div>
          </div>
          <div class="turn-detail-block">
            <div class="lab">Details</div>
            <div class="retry-pills">${facts.map(f => `<span class="retry-pill">${f}</span>`).join('')}</div>
            ${e.error_message ? `<div class="lab" style="margin-top:12px">Error</div><div class="codebox">${esc(e.error_message)}</div>` : ''}
            <div class="lab" style="margin-top:12px">AI model usage</div>
            ${renderTokens(d.tokens)}
          </div>
        </div>
        <div class="turn-detail-grid">
          <div class="turn-detail-block"><div class="lab">Answer quality</div>${renderJudge(d.judge)}</div>
          <div class="turn-detail-block"><div class="lab">Guardrails</div>${renderGuardEvents(d.guardrails && d.guardrails.events)}</div>
        </div>
        <div class="turn-detail-block"><div class="lab">Request trace</div>${d.trace ? renderWaterfall(d.trace, e.latency_ms, d.timeline) : renderTimeline(d.timeline, e.latency_ms)}</div>
        ${c && c.hit && c.originalTimeline && c.originalTimeline.length ? `<div class="turn-detail-block"><div class="lab">How it was originally answered</div>${renderTimeline(c.originalTimeline, c.originalLatencyMs)}</div>` : ''}
        <div class="turn-detail-block"><div class="lab">Generated SQL${c && c.hit ? ' (when the cached answer was generated)' : ''}</div>${renderQueries(d.queries)}</div>
      </div>`;
    detailTr.appendChild(td);
    tr.addEventListener('click', () => {
      detailTr.classList.toggle('open');
      tr.lastElementChild.textContent = detailTr.classList.contains('open') ? '▾' : '▸';
    });
    tbody.appendChild(tr);
    tbody.appendChild(detailTr);
  });
  if (!rows.length) tbody.innerHTML = '<tr><td colspan="9">No questions yet.</td></tr>';
}
document.getElementById('obsUserFilter').addEventListener('change', renderAuditTrail);

// ---------------------------------------------------------------- trends and insights (time range)

const OBS_COLORS = { deep: '#003B5C', quick: '#25B5C9', failed: '#DC2626', blocked: '#D97706', quality: '#059669', cache: '#0E9384' };

function obsChart(id, config) {
  if (obsCharts[id]) obsCharts[id].destroy();
  const el = document.getElementById(id);
  if (!el || typeof Chart === 'undefined') return;
  obsCharts[id] = new Chart(el, config);
}

const dayLabel = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const obsPct = v => (v === null || v === undefined || v === '' ? '—' : Math.round(Number(v) * 100) + '%');
const REASON_TEXT = { wrong_numbers: 'Wrong numbers', wrong_data: 'Wrong products, buckets or filters', not_answered: "Didn't answer the question", unclear: 'Hard to understand', other: 'Something else', none: 'No reason given' };

async function loadInsights() {
  let d;
  try { d = await fetch(`/api/admin/insights?days=${obsDays}`).then(r => r.json()); } catch { return; }
  window.obsInsights = d;
  document.dispatchEvent(new CustomEvent('lens:obs-insights', { detail: d }));
  const s = d.summary || {};
  const pe = d.people || {};
  const range = obsDays === 1 ? 'the last 24 hours' : obsDays ? `the last ${obsDays} days` : 'all time';

  // Health banner: the one-line verdict an owner reads first.
  const h = d.health || {};
  const verdict = h.status === 'healthy' ? ['ok', '✓', 'All healthy', `Answers are succeeding and quality is good over ${range}.`]
    : h.status === 'idle' ? ['idle', '•', 'No activity', `Nobody asked anything in ${range}.`]
    : ['warn', '!', 'Needs attention', `Over ${range}: ${h.issues.join('; ')}.`];
  document.getElementById('obsHealth').innerHTML = `<div class="health h-${verdict[0]}"><span class="health-ico">${verdict[1]}</span>
    <div><b>${verdict[2]}</b><span>${esc(verdict[3])}</span></div>
    <div class="health-chips"><span>${fmtNum(s.questions)} questions</span><span>${fmtNum(pe.users)} people</span><span>${fmtNum(pe.sessions)} conversations</span><span>${fmtNum(pe.active_today)} active today</span></div></div>`;

  const lat = Object.fromEntries((d.latency || []).map(r => [r.mode, r]));
  const rated = Number(s.up || 0) + Number(s.down || 0);
  const tiles = [
    ['Questions answered', obsPct(s.success_rate), `${fmtNum(s.questions)} asked in ${range}`, Number(s.success_rate) < 0.9 ? 'warn' : 'good'],
    ['Answer quality', obsPct(s.faithfulness), 'average faithfulness to the data', Number(s.faithfulness) && Number(s.faithfulness) < 0.8 ? 'warn' : null],
    ['Quick answer speed', lat.chat ? fmtMs(Number(lat.chat.p50)) : '—', lat.chat ? `typical · 90% within ${fmtMs(Number(lat.chat.p90))}` : 'no live quick answers', null],
    ['Deep analysis speed', lat.agent ? fmtMs(Number(lat.agent.p50)) : '—', lat.agent ? `typical · 90% within ${fmtMs(Number(lat.agent.p90))}` : 'no live deep analyses', null],
    ['Served instantly', obsPct(s.cache_rate), 'answered from the cache', null],
    ['Satisfaction', rated ? Math.round(100 * Number(s.up) / rated) + '%' : '—', `👍 ${fmtNum(s.up)} · 👎 ${fmtNum(s.down)}`, rated && Number(s.down) > Number(s.up) ? 'warn' : null],
    ['Safety checks acted', fmtNum(s.guarded), 'questions blocked, cleaned or flagged', null],
  ];
  document.getElementById('obsInsightKpis').innerHTML = tiles.map(([l, v, sub, t]) =>
    `<div class="metric${t ? ' m-' + t : ''}"><div class="metric-top"><span>${l}</span></div><div class="metric-v">${v}</div><div class="metric-s">${sub}</div></div>`).join('');

  const days = d.daily || [];
  const labels = days.map(r => dayLabel(r.day));
  const base = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } } } };
  obsChart('obsDailyChart', {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Deep analysis', data: days.map(r => r.deep), backgroundColor: OBS_COLORS.deep, stack: 'q', borderRadius: 3 },
      { label: 'Quick answer', data: days.map(r => r.quick), backgroundColor: OBS_COLORS.quick, stack: 'q', borderRadius: 3 },
      { label: 'Failed', data: days.map(r => r.failed), type: 'line', borderColor: OBS_COLORS.failed, backgroundColor: OBS_COLORS.failed, pointRadius: 2, tension: .3 },
    ] },
    options: { ...base, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } },
  });
  obsChart('obsSpeedChart', {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Deep analysis (s)', data: days.map(r => (r.deep_ms === null ? null : Number(r.deep_ms) / 1000)), borderColor: OBS_COLORS.deep, backgroundColor: OBS_COLORS.deep + '22', fill: true, tension: .3, spanGaps: true },
      { label: 'Quick answer (s)', data: days.map(r => (r.quick_ms === null ? null : Number(r.quick_ms) / 1000)), borderColor: OBS_COLORS.quick, backgroundColor: OBS_COLORS.quick + '22', fill: true, tension: .3, spanGaps: true },
    ] },
    options: { ...base, scales: { y: { beginAtZero: true, ticks: { callback: v => v + 's' } }, x: { grid: { display: false } } } },
  });
  obsChart('obsQualityChart', {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Faithfulness', data: days.map(r => (r.faithfulness === null ? null : Number(r.faithfulness) * 100)), borderColor: OBS_COLORS.quality, backgroundColor: OBS_COLORS.quality + '22', fill: true, tension: .3, spanGaps: true },
      { label: 'Served from cache', data: days.map(r => Number(r.cache_rate) * 100), borderColor: OBS_COLORS.cache, borderDash: [4, 4], pointRadius: 2, tension: .3 },
    ] },
    options: { ...base, scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } },
  });
  const hours = Array.from({ length: 24 }, (_, i) => (d.hourly || []).find(r => Number(r.hour) === i)?.n || 0);
  obsChart('obsHourChart', {
    type: 'bar',
    data: { labels: hours.map((_, i) => String(i).padStart(2, '0')), datasets: [{ label: 'Questions', data: hours, backgroundColor: '#0B6E99', borderRadius: 3 }] },
    options: { ...base, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false }, title: { display: true, text: 'Hour of day (UTC)', font: { size: 10 } } } } },
  });

  const top = d.topQuestions || [];
  document.getElementById('obsTopQuestions').innerHTML = `<div class="panel-head"><div><h3>Most-asked questions</h3><div class="panel-sub">What people want to know (${range})</div></div></div>
    <div class="panel-body">${top.map((q, i) => `<div class="tq"><span class="tq-n">${i + 1}</span><span class="tq-q" title="${esc(q.question)}">${esc(q.question)}</span>
      <span class="tq-m">${fmtNum(q.times)}×${q.people > 1 ? ` · ${q.people} people` : ''}${q.from_cache ? ` · ⚡${q.from_cache}` : ''}</span></div>`).join('') || '<div class="empty-note">No questions yet.</div>'}</div>`;

  document.getElementById('obsLatency').innerHTML = `<div class="panel-head"><div><h3>How long answers take</h3><div class="panel-sub">Live answers; half finish within the typical time</div></div></div>
    <div class="panel-body">${['agent', 'chat'].map(m => {
      const r = lat[m];
      if (!r) return `<div class="lat"><b>${modeName(m)}</b><span class="muted">No live answers in ${range}.</span></div>`;
      const max = Number(r.p95) || 1;
      return `<div class="lat"><b>${modeName(m)}</b> <span class="muted">${fmtNum(r.n)} answers</span>
        ${[['Typical (p50)', r.p50], ['Most (p90)', r.p90], ['Almost all (p95)', r.p95]].map(([l, v]) =>
          `<div class="lat-row"><span>${l}</span><span class="lat-track"><span class="t-${m === 'agent' ? 'deep' : 'quick'}" style="width:${(100 * Number(v) / max).toFixed(0)}%"></span></span><span class="mono">${fmtMs(Number(v))}</span></div>`).join('')}</div>`;
    }).join('')}</div>`;

  const reasons = d.reasons || [];
  const totalDown = reasons.reduce((a, r) => a + r.n, 0);
  document.getElementById('obsReasons').innerHTML = `<div class="panel-head"><div><h3>Why answers got a 👎</h3><div class="panel-sub">${totalDown ? `${totalDown} in ${range}` : `None in ${range}`}</div></div><button class="ask-link" data-tab-scroll="feedbackTable">Review queue ›</button></div>
    <div class="panel-body">${reasons.map(r => `<div class="hbar"><div class="hbar-top"><span class="hbar-label">${esc(REASON_TEXT[r.reason] || r.reason)}</span><span class="hbar-val">${r.n}</span></div>
      <div class="hbar-track"><span class="hbar-fill t-bad" style="width:${(100 * r.n / Math.max(1, totalDown)).toFixed(0)}%"></span></div></div>`).join('') || '<div class="empty-note">No 👎 feedback. 🎉</div>'}</div>`;
}

document.getElementById('obsRange').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-days]');
  if (!b) return;
  obsDays = Number(b.dataset.days);
  document.querySelectorAll('#obsRange button').forEach(x => x.classList.toggle('on', x === b));
  loadInsights();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab-scroll]');
  if (b) document.getElementById(b.dataset.tabScroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

let obsLoadedAt = 0;
/** Loads Observability. `maxAgeMs`: skip if it was loaded that recently (e.g. preloaded in the background). */
window.loadMonitoring = async function loadMonitoring({ maxAgeMs = 0 } = {}) {
  if (maxAgeMs && Date.now() - obsLoadedAt < maxAgeMs) return;
  obsLoadedAt = Date.now();
  loadInsights();
  let data;
  try { data = await fetch('/api/admin/usage').then(r => r.json()); } catch (err) { obsLoadedAt = 0; console.warn('Observability failed to load', err); return; }

  const kpis = document.getElementById('obsKpis');
  kpis.innerHTML = '';
  const successRate = data.totals.total_questions
    ? Math.round((100 * data.totals.successful) / data.totals.total_questions)
    : 0;
  const rated = data.totals.helpful + data.totals.not_helpful;
  kpis.appendChild(kpiCard('Total Questions', fmtNum(data.totals.total_questions)));
  kpis.appendChild(kpiCard('Success Rate', successRate + '%', null, successRate < 90 ? 'warn' : 'good'));
  kpis.appendChild(kpiCard('Avg Latency', fmtMs(Number(data.totals.avg_live_latency_ms ?? data.totals.avg_latency_ms)),
    'Live answers, excluding cache hits'));
  const hits = data.totals.cache_hits || 0;
  kpis.appendChild(kpiCard('Cache Hits', data.totals.total_questions ? Math.round((100 * hits) / data.totals.total_questions) + '%' : '—',
    `${fmtNum(hits)} answered instantly${data.totals.semantic_hits ? ` (${fmtNum(data.totals.semantic_hits)} similar-question)` : ''}${hits ? ` · avg ${fmtMs(Number(data.totals.avg_cache_latency_ms))}` : ''}${Number(data.totals.engine_ms_saved) ? ` · ${fmtMs(Number(data.totals.engine_ms_saved))} of waiting saved` : ''}`));
  const judgeCfg = data.ai && data.ai.config && data.ai.config.judge;
  const judged = data.totals.judged || 0;
  kpis.appendChild(kpiCard('Faithfulness', judged ? Math.round(Number(data.totals.avg_faithfulness) * 100) + '%' : '—',
    judgeCfg ? `${fmtNum(judged)} judged · ${judgeCfg.model ? esc(judgeCfg.model) : 'numbers check only'}${data.totals.low_faithfulness ? ` · ${fmtNum(data.totals.low_faithfulness)} below ${Math.round((judgeCfg.warnBelow || 0.7) * 100)}%` : ''}` : 'Judge off',
    data.totals.low_faithfulness ? 'warn' : null));
  const pctOrDash = v => (v === null || v === undefined ? '—' : Math.round(Number(v) * 100) + '%');
  if (judgeCfg && data.totals.avg_relevance !== null) {
    kpis.appendChild(kpiCard('Relevance', pctOrDash(data.totals.avg_relevance),
      `Completeness ${pctOrDash(data.totals.avg_completeness)} · Safety ${pctOrDash(data.totals.avg_safety)}`));
  }
  kpis.appendChild(kpiCard('Blocked', fmtNum(data.totals.blocked || 0),
    data.ai && data.ai.config && data.ai.config.guardrails ? 'Questions stopped by guardrails' : 'Guardrails off'));
  kpis.appendChild(kpiCard('Helpful Ratings', rated ? Math.round((100 * data.totals.helpful) / rated) + '%' : '—',
    `👍 ${fmtNum(data.totals.helpful)}  ·  👎 ${fmtNum(data.totals.not_helpful)}`,
    rated && data.totals.not_helpful > data.totals.helpful ? 'warn' : null));


  const userBody = document.querySelector('#userTable tbody');
  userBody.innerHTML = '';
  data.byUser.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(userName(u.user_email))}</td><td>${fmtNum(u.sessions)}</td><td>${fmtNum(u.questions)}</td><td>${fmtNum(u.successful)}</td>
      <td>${fmtNum(u.avg_latency_ms)} ms</td><td>${new Date(u.last_active).toLocaleString()}</td>`;
    userBody.appendChild(tr);
  });

  renderCache(data.cache);
  renderAi(data.ai);
  renderCost(data.cost);
  obsFeedback = data.feedbackQueue || [];
  renderFeedback();

  obsRecent = data.recent;
  window.obsUsage = data;
  document.dispatchEvent(new CustomEvent('lens:obs-usage', { detail: data }));
  const sel = document.getElementById('obsUserFilter');
  const current = sel.value;
  const users = [...new Set(obsRecent.map(e => e.user_email))];
  sel.innerHTML = '<option value="">All users</option>' +
    users.map(u => `<option value="${esc(u)}">${esc(userName(u))}</option>`).join('');
  sel.value = users.includes(current) ? current : '';
  renderAuditTrail();

  obsLoaded = true;
};

/** Tokens by feature and model, and an estimated cost when prices are configured. */
function renderCost(cost) {
  const status = document.getElementById('obsCostStatus');
  const tbody = document.querySelector('#costTable tbody');
  const rows = (cost && cost.rows) || [];
  const tot = rows.reduce((a, r) => ({ calls: a.calls + r.calls, input: a.input + r.input, output: a.output + r.output, cost: a.cost + (r.cost || 0) }), { calls: 0, input: 0, output: 0, cost: 0 });
  status.innerHTML = `<div class="retry-pills">
    <span class="retry-pill">${fmtNum(tot.calls)} model calls</span>
    <span class="retry-pill">${fmtNum(tot.input)} input tokens · ${fmtNum(tot.output)} output tokens</span>
    <span class="retry-pill">${cost && cost.priced ? `Estimated cost $${tot.cost.toFixed(2)}` : 'Cost: set "pricing" in the deploy config to estimate it'}</span>
    <span class="retry-pill">The query engine's own usage is billed with the SQL warehouse and isn't counted here</span></div>`;
  tbody.innerHTML = rows.map(r => `<tr><td>${esc(featureLabel(r.feature))}</td><td>${esc(r.modelLabel)}</td>
    <td>${r.source === 'evals' ? 'Eval runs' : `${fmtNum(r.questions)} question${r.questions === 1 ? '' : 's'}`}</td>
    <td>${fmtNum(r.calls)}</td><td>${fmtNum(r.input)}</td><td>${fmtNum(r.output)}</td><td>${r.cost === null ? '—' : '$' + r.cost.toFixed(4)}</td></tr>`).join('')
    || '<tr><td colspan="7">No AI model calls recorded yet.</td></tr>';
}

const FB_REASON_LABELS = { wrong_numbers: 'Wrong numbers', wrong_data: 'Wrong products, buckets or filters', not_answered: "Didn't answer the question", unclear: 'Hard to understand', other: 'Something else' };
const REVIEW_LABELS = { open: 'Open', fixed: 'Fixed', dismissed: 'Dismissed', added_to_evals: 'Added to evals' };

/** The 👎 review queue: each one can be marked fixed, dismissed, or added to the evaluation suite. */
function renderFeedback() {
  const want = document.getElementById('fbFilter').value;
  const rows = want ? obsFeedback.filter(f => f.review_status === want) : obsFeedback;
  const tbody = document.querySelector('#feedbackTable tbody');
  tbody.innerHTML = '';
  rows.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(f.created_at).toLocaleString()}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(userName(f.user_email))}</td>
      <td style="max-width:320px;white-space:normal" title="${esc(f.answer_preview)}">${esc(f.question)}</td>
      <td style="white-space:normal">${esc(FB_REASON_LABELS[f.feedback_reason] || 'No reason given')}${f.feedback_comment ? `<div class="score-reason">“${esc(f.feedback_comment)}”</div>` : ''}</td>
      <td>${faithChip(f.faithfulness)}</td>
      <td><span class="chip ${f.review_status === 'open' ? 'warn' : 'neutral'}">${esc(REVIEW_LABELS[f.review_status] || f.review_status)}</span>${f.reviewed_by ? `<div class="score-reason">${esc(f.reviewed_by)}</div>` : ''}</td>
      <td class="fb-actions">${f.review_status === 'open'
        ? '<button data-s="fixed">Fixed</button><button data-s="added_to_evals">Add to evals</button><button data-s="dismissed">Dismiss</button>'
        : '<button data-s="open">Reopen</button>'}</td>`;
    tr.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await fetch(`/api/admin/feedback/${f.event_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.s }),
      });
      if (r.ok) { f.review_status = b.dataset.s; renderFeedback(); } else b.disabled = false;
    }));
    tbody.appendChild(tr);
  });
  if (!rows.length) tbody.innerHTML = `<tr><td colspan="7">${obsFeedback.length ? 'Nothing here.' : 'No 👎 feedback yet.'}</td></tr>`;
}
document.getElementById('fbFilter').addEventListener('change', renderFeedback);

/** What's in the answer cache for the current data and semantic-model versions. */
function renderCache(cache) {
  const status = document.getElementById('obsCacheStatus');
  const tbody = document.querySelector('#cacheTable tbody');
  tbody.innerHTML = '';
  if (!cache) {
    status.innerHTML = '<div class="score-reason">Answer cache unavailable (run the deploy lakebase step to create its tables).</div>';
    return;
  }
  const v = Object.fromEntries((cache.versions || []).map(r => [r.name, r]));
  const p = cache.lastPrewarm;
  const prewarm = !p ? 'not run yet'
    : `${p.status}, ${p.answered} question${p.answered === 1 ? '' : 's'} answered, ${new Date(p.finished_at || p.started_at).toLocaleString()}`;
  status.innerHTML = `<div class="retry-pills">
    <span class="retry-pill">${cache.enabled ? 'Cache on' : 'Cache off (LENS_ANSWER_CACHE=off)'}</span>
    <span class="retry-pill">Data version: ${esc(v.data ? v.data.version : '—')}</span>
    <span class="retry-pill">Semantic model version: ${esc(v.genie ? v.genie.version : '—')}</span>
    <span class="retry-pill">Last pre-warm: ${esc(prewarm)}</span>
    <span class="retry-pill">${fmtNum(cache.entries.length)} cached answer${cache.entries.length === 1 ? '' : 's'}</span></div>`;
  cache.entries.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.question)}">${esc(e.question)}</td>
      <td><span class="badge ${e.mode === 'agent' ? 'amber' : 'green'}">${esc(modeName(e.mode))}</span></td>
      <td>${e.source === 'prewarm' ? 'Pre-warmed' : 'Earlier answer'}</td><td>${fmtNum(e.hits)}</td>
      <td>${new Date(e.created_at).toLocaleString()}</td>
      <td>${e.expires_at ? new Date(e.expires_at).toLocaleString() : 'When the data or semantic model changes'}</td>`;
    tbody.appendChild(tr);
  });
  if (!cache.entries.length) tbody.innerHTML = '<tr><td colspan="6">Nothing cached for the current versions yet.</td></tr>';
}

/** Which AI features are on, with their models, and what the guardrails have done. */
function renderAi(ai) {
  const status = document.getElementById('obsAiStatus');
  const c = (ai && ai.config) || {};
  const pill = s => `<span class="retry-pill">${s}</span>`;
  const g = c.guardrails;
  status.innerHTML = `<div class="retry-pills">
    ${pill(c.semanticCache ? `Semantic cache: on, ≥ ${(c.semanticCache.threshold * 100).toFixed(0)}% similar · ${esc(c.semanticCache.model)}` : 'Semantic cache: off')}
    ${pill(g ? `Guardrails: on · ${g.model ? 'classifier ' + esc(g.model) : 'pattern checks only'}` : 'Guardrails: off')}
    ${g ? pill(`Input: PII ${g.input.pii}, profanity ${g.input.profanity}, injection ${g.input.prompt_injection}, off-topic ${g.input.off_topic}`) : ''}
    ${g ? pill(`Output: PII ${g.output.pii}, profanity ${g.output.profanity}, policy checks ${g.output.policy_checks}`) : ''}
    ${pill(c.judge ? `Answer-quality judge: on · ${c.judge.model ? esc(c.judge.model) : 'numbers check only'} · ${c.judge.samplePercent}% of answers · warns below ${Math.round((c.judge.warnBelow || 0.7) * 100)}%` : 'Answer-quality judge: off')}
    ${pill(c.followUps ? `Follow-up suggestions: ${esc(c.followUps.model)}` : 'Follow-up suggestions: engine only')}
    ${pill(c.autoMode ? `Auto mode: ${c.autoMode.method === 'ai' ? 'AI classifier ' + esc(c.autoMode.model || '') : 'word rule (no model)'}` : 'Auto mode: word rule')}
    ${pill(c.evals ? `Evals: on · up to ${c.evals.maxAccuracyCases} ground-truth questions per run` : 'Evals: off')}
  </div>`;
  const counts = document.querySelector('#guardTable tbody');
  counts.innerHTML = ((ai && ai.guardCounts) || []).map(r =>
    `<tr><td>${esc(r.stage)}</td><td>${esc(guardLabel(r.check_name))}</td><td>${esc(r.action)}</td><td>${fmtNum(r.n)}</td></tr>`).join('')
    || '<tr><td colspan="4">No guardrail checks have fired.</td></tr>';
  const events = document.querySelector('#guardEventsTable tbody');
  events.innerHTML = ((ai && ai.guardEvents) || []).map(e => {
    const checks = (e.events || []).map(x => `${guardLabel(x.check)} (${x.action})`).join(', ');
    return `<tr><td>${new Date(e.created_at).toLocaleString()}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(userName(e.user_email))}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.question)}">${esc(e.question)}</td>
      <td>${esc(e.guard_action)}: ${esc(checks)}</td></tr>`;
  }).join('') || '<tr><td colspan="4">No guardrail events yet.</td></tr>';
}
