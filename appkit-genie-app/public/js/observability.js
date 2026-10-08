// ---------------------------------------------------------------- Observability (5 areas)
// Built on the live logs (monitoring.js fetches them): a headline row, then five areas,
// 1 pipeline traces, 2 answer quality, 3 performance, 4 data & model drift, 5 security.
// The trace console shows each question's governed execution path with real timings.

(function setupObservability() {
  const oEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p0 = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '—' : Math.round(Number(v) * 100) + '%');
  const p1 = v => (v === null || v === undefined || v === '' ? '—' : (Number(v) * 100).toFixed(1) + '%');
  const ms = v => (v === null || v === undefined ? '—' : Number(v) >= 1000 ? (Number(v) / 1000).toFixed(1) + ' s' : Math.round(Number(v)) + ' ms');
  const userLabel = e => userName(e.user_email);
  const charts = {};
  const chart = (id, cfg) => { if (charts[id]) charts[id].destroy(); const el = document.getElementById(id); if (el && window.Chart) charts[id] = new Chart(el, cfg); };

  // ---- area tabs
  const tabs = document.getElementById('obsTabs');
  const showPane = (name) => {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.pane === name));
    document.querySelectorAll('#tab-obs .obs-pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
    try { localStorage.setItem('lensmlops.obsPane', name); } catch { /* ignore */ }
    window.currentObsPane = name;
    // Areas 6 and 7 load their own data the first time they are opened.
    if (name === 'evals' && window.loadEvals && document.getElementById('tab-obs').classList.contains('on')) window.loadEvals();
    if (name === 'rai' && window.loadResponsibleAi && document.getElementById('tab-obs').classList.contains('on')) window.loadResponsibleAi();
    Object.values(charts).forEach(c => c.resize());
  };
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button[data-pane]'); if (b) showPane(b.dataset.pane); });
  try { const saved = localStorage.getItem('lensmlops.obsPane'); if (saved) showPane(saved); } catch { /* ignore */ }
  window.showObsPane = showPane;

  let usage = null;
  let insights = null;
  let filter = 'all';
  let selected = null;

  const statusOf = e => (e.guard_action === 'blocked' ? 'blocked' : e.success ? 'passed' : 'failed');

  // ---- headline row: groundedness, numeric reconciliation, latency, personal-data guardrail
  function renderHeadline() {
    if (!insights) return;
    const s = insights.summary || {};
    const r = insights.reconciliation || {};
    const lat = Object.fromEntries((insights.latency || []).map(x => [x.mode, x]));
    const all = (insights.latency || []);
    const p50 = all.length ? all.reduce((a, x) => a + Number(x.p50) * x.n, 0) / all.reduce((a, x) => a + x.n, 0) : null;
    const p95 = all.length ? Math.max(...all.map(x => Number(x.p95))) : null;
    const piiIn = (insights.pii || []).filter(x => x.stage === 'input').reduce((a, x) => a + x.n, 0);
    const piiOut = (insights.pii || []).filter(x => x.stage === 'output').reduce((a, x) => a + x.n, 0);
    const recon = r.checked ? r.found / r.checked : null;
    const cards = [
      ['Groundedness score', p1(s.faithfulness), `${r.unsupported ? r.unsupported + ' unsupported claim' + (r.unsupported === 1 ? '' : 's') : 'Zero unsupported claims'} · ${r.llm_judged || 0} answers judged`, Number(s.faithfulness) >= 0.9 ? 'good' : 'warn'],
      ['Numeric reconciliation', recon === null ? '—' : p1(recon), r.checked ? `${r.found} of ${r.checked} figures matched to query results` : 'No figures checked yet', recon !== null && recon >= 0.9 ? 'good' : 'warn'],
      ['Average end-to-end latency', ms(p50), p95 ? `P95: ${ms(p95)} · quick ${lat.chat ? ms(lat.chat.p50) : '—'}, deep ${lat.agent ? ms(lat.agent.p50) : '—'}` : 'No live answers yet', null],
      ['Personal-data guardrail', piiOut ? `${piiOut} redacted` : '100% pass', `${piiIn} question${piiIn === 1 ? '' : 's'} masked before processing · ${piiOut ? 'output redacted before display' : 'zero personal data in answers'}`, 'good'],
    ];
    document.getElementById('obsHeadline').innerHTML = cards.map(([l, v, sub, t]) =>
      `<div class="hl-card${t ? ' h-' + t : ''}"><div class="hl-l">${l}</div><div class="hl-v">${v}</div><div class="hl-s">${oEsc(sub)}</div></div>`).join('');
    const t = insights.traces || {};
    document.getElementById('obsTraceCount').innerHTML = t.total ? `<b>${Number(t.total).toLocaleString()}</b> governed traces logged · latest ${new Date(t.latest).toLocaleString()}` : '';
  }

  // ---- 1. pipeline traces
  function renderTraceList() {
    if (!usage) return;
    const term = (document.getElementById('traceSearch').value || '').toLowerCase();
    const who = document.getElementById('obsUserFilter').value;
    const rows = (usage.recent || []).filter(e => (filter === 'all' || statusOf(e) === filter)
      && (!who || e.user_email === who) && (!term || String(e.question).toLowerCase().includes(term)));
    const box = document.getElementById('traceItems');
    box.innerHTML = rows.map(e => {
      const st = statusOf(e);
      const toks = Object.values((e.details || {}).tokens || {}).reduce((a, x) => a + (x.input || 0) + (x.output || 0), 0);
      return `<button class="trace-item${selected === e.event_id ? ' on' : ''}" data-id="${e.event_id}">
        <div class="ti-top"><span class="ti-when">${new Date(e.created_at).toLocaleString()}</span><span class="st st-${st}">${st === 'passed' ? 'Passed' : st === 'blocked' ? 'Blocked' : 'Failed'}</span></div>
        <div class="ti-q">“${oEsc(String(e.question).slice(0, 160))}”</div>
        <div class="ti-meta"><span>${oEsc(userLabel(e))} · ${modeName(e.mode)}</span><span>${ms(e.latency_ms)}${toks ? ` · ${toks.toLocaleString()} tokens` : ''}${e.from_cache ? ' · ⚡ cache' : ''}</span></div>
      </button>`;
    }).join('') || '<div class="empty-note">No traces match.</div>';
    box.querySelectorAll('.trace-item').forEach(b => b.addEventListener('click', () => { selected = b.dataset.id; renderTraceList(); renderTraceDetail(); }));
    if (!selected && rows[0]) { selected = rows[0].event_id; renderTraceList(); renderTraceDetail(); }
  }

  /** The 9-stage governed execution path, from the request trace and the logged details. */
  function stagesOf(e) {
    const d = e.details || {};
    const spans = d.trace || [];
    const sum = re => spans.filter(s => re.test(s.name)).reduce((a, s) => a + (s.ms || 0), 0);
    const g = (d.guardrails && d.guardrails.events) || [];
    const inG = g.filter(x => x.stage === 'input');
    const outG = g.filter(x => x.stage === 'output');
    const c = d.cache || {};
    const q = d.queries || [];
    const rows = q.reduce((a, x) => a + (Number(x.rows) || 0), 0);
    const j = d.judge;
    const toks = Object.values(d.tokens || {}).reduce((a, x) => a + (x.input || 0) + (x.output || 0), 0);
    const blocked = e.guard_action === 'blocked';
    const tl = d.timeline || [];
    const stageMs = re => tl.filter(s => re.test(s.stage)).reduce((a, s) => a + (s.ms || 0), 0);
    const engine = spans.find(s => /^Lens query engine/.test(s.name));
    return [
      ['Ask', sum(/^Input checks/), `Question received in ${modeName(e.mode)} mode${d.autoMode ? ` (chosen by Auto, ${d.autoMode.method === 'ai' ? 'AI classifier' : 'word rule'}${d.autoMode.reason ? ': ' + d.autoMode.reason : ''})` : ''}${d.contextCarriedOver ? (d.memory ? `, with the conversation so far as context (${d.memory.turns} earlier question${d.memory.turns === 1 ? '' : 's'}${d.memory.summarized ? `, ${d.memory.summarized} of them summarised` : ''})` : ', with earlier turns carried over as context') : ''}.`],
      ['Secure', sum(/Input classifier/), inG.length ? `Checks fired: ${inG.map(x => `${x.check} → ${x.action}`).join(', ')}.` : 'Personal data, offensive language, prompt injection and off-topic checks passed.'],
      ['Cache', sum(/^Answer cache|Question embedding/), c.hit ? `Served from the answer cache (${c.match === 'semantic' ? 'similar question' : 'exact match'}).` : c.closest ? `No match; closest cached question was ${(c.closest.similarity * 100).toFixed(1)}% similar.` : 'Not eligible for the cache (follow-up question) or no match.'],
      ['Plan', stageMs(/metadata|context|Writing SQL|Reasoning|Sending/) + sum(/^Platform guide/), blocked ? 'Not run: the question was blocked.' : d.platformHelp ? `A question about the platform: answered from the Lens MLOps platform guide (${d.platformHelp.method === 'ai' ? 'AI model' : 'guide text'}; ${(d.platformHelp.sections || []).join(', ')}), not the data.` : c.hit ? 'Reused the plan of the cached answer.' : `Query engine selected certified sources${(d.sources || []).length ? ` (${d.sources.join(', ')})` : ''} and wrote ${q.length} SQL quer${q.length === 1 ? 'y' : 'ies'}.`],
      ['Retrieve', stageMs(/warehouse|Running SQL|Fetching/), blocked ? '—' : `${q.length} quer${q.length === 1 ? 'y' : 'ies'} on the governed gold views returned ${rows.toLocaleString()} row${rows === 1 ? '' : 's'}.`],
      ['Verify', sum(/^Output checks|quality judge/), j ? `Output checks ${outG.length ? outG.map(x => x.check).join(', ') + ' acted' : 'passed'}; judge scored ${p0(j.score)} (${(j.numeric || {}).found ?? 0}/${(j.numeric || {}).checked ?? 0} figures reconciled).` : `Output checks ${outG.length ? outG.map(x => x.check).join(', ') + ' acted' : 'passed'}${blocked ? '' : '; not scored'}.`],
      ['Synthesize', stageMs(/Writing the answer|Building chart|Finishing/) + sum(/Follow-up/), blocked ? 'Explained why the question was blocked.' : `Answer with ${d.charts || 0} chart${d.charts === 1 ? '' : 's'}${d.followUps ? ` and ${d.followUps} follow-up questions` : ''}.`],
      ['Deliver', engine ? 0 : e.latency_ms, `Delivered to ${oEsc(userLabel(e))} in ${ms(e.latency_ms)}${e.from_cache ? ' from the cache' : ''}.`],
      ['Log', 0, `Logged to the audit trail with request trace${toks ? `, ${toks.toLocaleString()} AI tokens` : ''} and quality score.`],
    ];
  }

  function renderTraceDetail() {
    const e = (usage && usage.recent || []).find(x => x.event_id === selected);
    const el = document.getElementById('traceDetail');
    if (!e) { el.innerHTML = '<div class="empty-note">Select a trace to see its full execution path.</div>'; return; }
    const d = e.details || {};
    const st = statusOf(e);
    const intent = (d.platformHelp ? 'Platform question' : modeName(e.mode)) + (st === 'blocked' ? ', blocked' : d.cache && d.cache.hit ? ', from the answer cache' : '');
    const stages = stagesOf(e);
    const q = d.queries || [];
    el.innerHTML = `
      <div class="td-head"><span class="muted">${new Date(e.created_at).toLocaleString()}</span><span class="st st-${st}">${st === 'passed' ? 'Passed' : st === 'blocked' ? 'Blocked' : 'Failed'}</span></div>
      <div class="td-intent">${intent}</div>
      <div class="td-prompt"><div class="td-lab">Audited input prompt · ${oEsc(userLabel(e))}</div>“${oEsc(e.question)}”</div>
      <div class="td-lab">Lens 9-stage governed execution path</div>
      <ol class="td-stages">${stages.map(([n, t, desc], i) => `<li><span class="td-n">${i + 1}</span><div><div class="td-sn">${n} <span class="td-ms">${t ? ms(t) : ''}</span></div><div class="td-sd">${desc}</div></div></li>`).join('')}</ol>
      ${d.trace ? `<div class="td-lab">Request trace</div>${renderWaterfall(d.trace, e.latency_ms, d.timeline)}` : ''}
      ${q.length ? `<div class="td-lab">Synthesized execution logic</div>${q.map(x => `<div class="td-sql"><div class="td-sql-h">${oEsc(x.title || 'Query')}<button class="copy-sql" data-sql="${oEsc(x.sql || '')}">Copy</button></div><pre>${oEsc(x.sql || '')}</pre></div>`).join('')}` : ''}
      <div class="td-foot">${st === 'blocked' ? 'Stopped by a guardrail before any data was queried' : 'Personal data screened · certified sources only · figures reconciled by the judge'}</div>`;
    el.querySelectorAll('.copy-sql').forEach(b => b.addEventListener('click', () => { navigator.clipboard?.writeText(b.dataset.sql); b.textContent = 'Copied'; }));
  }
  document.getElementById('traceFilter').addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip-btn'); if (!b) return;
    filter = b.dataset.f;
    document.querySelectorAll('#traceFilter .chip-btn').forEach(x => x.classList.toggle('on', x === b));
    selected = null; renderTraceList();
  });
  document.getElementById('traceSearch').addEventListener('input', () => { selected = null; renderTraceList(); });
  document.getElementById('obsUserFilter').addEventListener('change', () => { selected = null; renderTraceList(); });

  /** Open Observability on one answer's trace (from the Assistant's Details). */
  window.openTraceForMessage = function openTraceForMessage(messageId) {
    window.showTab && window.showTab('obs');
    showPane('traces');
    const tryOpen = (n) => {
      const e = usage && (usage.recent || []).find(x => x.assistant_message_id === messageId);
      if (e) { selected = e.event_id; filter = 'all'; renderTraceList(); renderTraceDetail(); document.getElementById('traceDetail').scrollIntoView({ behavior: 'smooth' }); }
      else if (n > 0) setTimeout(() => tryOpen(n - 1), 700);
    };
    tryOpen(8);
  };

  // ---- 2. quality
  function renderQuality() {
    if (!insights || !usage) return;
    const s = insights.summary || {};
    const t = usage.totals || {};
    const rated = Number(s.up || 0) + Number(s.down || 0);
    document.getElementById('obsQualityTiles').innerHTML = [
      ['Faithfulness', p1(s.faithfulness), 'claims and figures supported by the data'],
      ['Relevance', p0(t.avg_relevance), 'answers the question asked (all time)'],
      ['Completeness', p0(t.avg_completeness), 'covers every part of the question (all time)'],
      ['Safety', p0(t.avg_safety), 'no personal data or unsupported forecasts (all time)'],
      ['Satisfaction', rated ? Math.round(100 * Number(s.up) / rated) + '%' : '—', `👍 ${s.up || 0} · 👎 ${s.down || 0}`],
    ].map(([l, v, sub]) => `<div class="metric"><div class="metric-top"><span>${l}</span></div><div class="metric-v">${v}</div><div class="metric-s">${sub}</div></div>`).join('');
    const m = [['Faithfulness', Number(t.avg_faithfulness)], ['Relevance', Number(t.avg_relevance)], ['Completeness', Number(t.avg_completeness)], ['Safety', Number(t.avg_safety)]];
    document.getElementById('obsMetrics').innerHTML = `<div class="panel-head"><div><h3>Quality metrics (all time)</h3><div class="panel-sub">Scored by the answer-quality judge on every live answer</div></div></div>
      <div class="panel-body">${m.map(([l, v]) => bar(l, v || 0, 1, p1(v), v >= 0.9 ? 'good' : v >= 0.75 ? 'warn' : 'bad')).join('')}</div>`;
    const low = insights.lowConfidence || [];
    document.getElementById('obsLowConf').innerHTML = `<div class="panel-head"><div><h3>Low-confidence answers</h3><div class="panel-sub">Scored below the warning threshold in this period</div></div></div>
      <div class="panel-body">${low.map(x => `<button class="lc-item" data-id="${x.event_id}"><span class="chip bad">${p0(x.faithfulness)}</span><span class="lc-q">${oEsc(x.question)}</span>
        <small>${[...(x.unsupported || []), ...(x.missing || []).map(v => 'figure ' + v)].slice(0, 3).map(oEsc).join(' · ') || 'no detail recorded'}</small></button>`).join('') || '<div class="empty-note">None: every scored answer cleared the threshold.</div>'}</div>`;
    document.querySelectorAll('#obsLowConf .lc-item').forEach(b => b.addEventListener('click', () => { selected = b.dataset.id; filter = 'all'; showPane('traces'); renderTraceList(); renderTraceDetail(); }));
  }

  // ---- 3. performance: average time per stage
  function renderStages() {
    if (!insights) return;
    const rows = insights.stages || [];
    const max = Math.max(...rows.map(r => Number(r.avg_ms)), 1);
    document.getElementById('obsStages').innerHTML = `<div class="panel-head"><div><h3>Where the time goes</h3><div class="panel-sub">Average time per stage, live answers</div></div></div>
      <div class="panel-body">${rows.slice(0, 8).map(r => bar(`${oEsc(r.stage)} <span class="muted">· ${modeName(r.mode)}</span>`, Number(r.avg_ms), max, ms(r.avg_ms), r.mode === 'agent' ? 'brand' : 'good')).join('') || '<div class="empty-note">No live answers in this period.</div>'}</div>`;
  }

  // ---- 4. data & model drift
  async function renderDrift() {
    if (!usage || !insights) return;
    const cache = usage.cache || {};
    const v = Object.fromEntries((cache.versions || []).map(r => [r.name, r]));
    const p = cache.lastPrewarm;
    document.getElementById('obsFreshness').innerHTML = `<div class="panel-head"><div><h3>Data freshness &amp; versions</h3><div class="panel-sub">What the assistant is answering from right now</div></div></div>
      <div class="panel-body"><table class="mini"><tbody>
        <tr><td>Data snapshot</td><td><b>15 September 2026</b></td></tr>
        <tr><td>Data version</td><td class="mono">${oEsc(v.data ? v.data.version : '—')}</td><td class="muted">${v.data ? new Date(v.data.updated_at).toLocaleString() : ''}</td></tr>
        <tr><td>Semantic model version</td><td class="mono">${oEsc(v.genie ? v.genie.version : '—')}</td><td class="muted">${v.genie ? new Date(v.genie.updated_at).toLocaleString() : ''}</td></tr>
        <tr><td>Answer cache</td><td>${cache.enabled ? `${(cache.entries || []).length} answers for these versions` : 'off'}</td></tr>
        <tr><td>Last pre-warm</td><td>${p ? `${oEsc(p.status)}, ${p.answered} answered` : 'not run'}</td></tr>
      </tbody></table>
      <div class="panel-note">When the data or semantic model changes, cached answers are retired automatically, so answers never drift from the current version.</div></div>`;
    const c = (usage.ai && usage.ai.config) || {};
    const models = [
      ['Query engine', 'Lens query engine (certified semantic model)'],
      ['Guardrail classifier', c.guardrails && c.guardrails.model],
      ['Question embeddings', c.semanticCache && c.semanticCache.model],
      ['Answer-quality judge', c.judge && c.judge.model],
      ['Follow-up suggestions', c.followUps && c.followUps.model],
      ['Auto mode router', c.autoMode ? (c.autoMode.method === 'ai' ? c.autoMode.model : 'word rule (no model)') : null],
      ['Platform questions', c.platformHelp ? (c.platformHelp.method === 'ai' ? c.platformHelp.model : 'platform guide text (no model)') : null],
      ['Conversation memory', c.memory ? `${c.memory.model || 'digest, no model'} · every ${c.memory.compactEvery} questions` : null],
    ];
    document.getElementById('obsModels').innerHTML = `<div class="panel-head"><div><h3>Models in use</h3><div class="panel-sub">Pinned per deployment; a change shows up here and in eval runs</div></div></div>
      <div class="panel-body"><table class="mini"><tbody>${models.map(([k, m]) => `<tr><td>${k}</td><td>${m ? `<b>${oEsc(m)}</b>` : '<span class="muted">off</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    const days = insights.daily || [];
    chart('obsMixChart', {
      type: 'line',
      data: { labels: days.map(r => new Date(r.day + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
        datasets: [{ label: 'Deep analysis share', data: days.map(r => { const t = r.deep + r.quick; return t ? Math.round(100 * r.deep / t) : null; }), borderColor: '#0B6E99', backgroundColor: '#0B6E9922', fill: true, tension: .3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { callback: x => x + '%' } }, x: { grid: { display: false } } } },
    });
    try {
      const ev = await fetch('/api/evals').then(r => r.json());
      const runs = (ev.runs || []).filter(r => r.status === 'done').reverse();
      const pr = (r, k) => { const c2 = r.summary && r.summary.categories && r.summary.categories[k]; return c2 && c2.passRate !== null && c2.passRate !== undefined ? Math.round(100 * c2.passRate) : null; };
      chart('obsEvalChart', {
        type: 'line',
        data: { labels: runs.map(r => new Date(r.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + new Date(r.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
          datasets: [['accuracy', 'Accuracy', '#1D4ED8'], ['guardrail', 'Guardrails', '#059669'], ['policy', 'Policy', '#D97706']].map(([k, l, col]) => ({ label: l, data: runs.map(r => pr(r, k)), borderColor: col, backgroundColor: col, spanGaps: true, tension: .3 })) },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100, ticks: { callback: x => x + '%' } } }, plugins: { legend: { labels: { boxWidth: 10 } } } },
      });
    } catch { /* evals off */ }
  }

  // ---- 5. security
  function renderSecurity() {
    if (!usage || !insights) return;
    const t = usage.totals || {};
    const counts = (usage.ai && usage.ai.guardCounts) || [];
    const by = (stage, check) => counts.filter(r => r.stage === stage && (!check || r.check_name === check)).reduce((a, r) => a + r.n, 0);
    const g = usage.ai && usage.ai.config && usage.ai.config.guardrails;
    document.getElementById('obsSecTiles').innerHTML = [
      ['Guardrails', g ? 'On' : 'Off', g ? `classifier ${g.model || 'patterns only'}` : 'not configured'],
      ['Questions blocked', String(t.blocked || 0), 'stopped before any data was queried'],
      ['Personal data masked', String(by('input', 'pii')), 'in questions, before processing or storage'],
      ['Prompt injections stopped', String(by('input', 'prompt_injection')), 'attempts to override the rules'],
      ['Answers checked', String(by('output')), 'policy wording, personal data and profanity actions'],
    ].map(([l, v, sub]) => `<div class="metric"><div class="metric-top"><span>${l}</span></div><div class="metric-v">${oEsc(v)}</div><div class="metric-s">${oEsc(sub)}</div></div>`).join('');
  }

  document.addEventListener('lens:obs-usage', (e) => { usage = e.detail; renderTraceList(); renderTraceDetail(); renderQuality(); renderDrift(); renderSecurity(); });
  document.addEventListener('lens:obs-insights', (e) => { insights = e.detail; renderHeadline(); renderQuality(); renderStages(); renderDrift(); renderSecurity(); });
})();
