// ---------------------------------------------------------------- Evals tab
// Runs the evaluation suite on demand and shows the latest scores, the history
// of runs (so a change to the semantic model, the models or the guardrails can
// be compared with the run before it), each case's result, and the cases.

let evalData = null;
let evalPoll = null;
let evalSelectedRun = null;

const CAT_LABELS = { accuracy: 'Accuracy', guardrail: 'Guardrails', policy: 'Policy', routing: 'Routing' };
const pct0 = v => (v === null || v === undefined ? '—' : Math.round(Number(v) * 100) + '%');

function expectedLabel(cat, exp, hasTruth) {
  if (cat === 'routing') {
    const [dest, depth, fresh] = String(exp || 'data').split(':');
    if (dest === 'platform') return 'The Lens MLOps guide';
    return `The data${depth ? `, ${depth === 'deep' ? 'deep analysis' : 'quick answer'}` : ''}${fresh ? ', fresh' : ''}`;
  }
  if (cat === 'accuracy') return exp === 'decline' ? 'Declines' : hasTruth === false ? 'Judged only' : 'Matches ground truth';
  if (!exp || exp === 'allow') return 'Allowed untouched';
  if (exp === 'block') return 'Blocked';
  if (exp === 'redact') return 'Personal details removed';
  const [kind, check] = exp.split(':');
  const name = (typeof CHECK_LABELS !== 'undefined' && CHECK_LABELS[check]) || check;
  return kind === 'detect' ? `Detects ${name}` : `Flags ${name}`;
}

function passChip(p) {
  if (p === true) return '<span class="chip ok">pass</span>';
  if (p === false) return '<span class="chip bad">fail</span>';
  return '<span class="chip neutral">n/a</span>';
}

function catSummary(run, cat) { return run && run.summary && run.summary.categories && run.summary.categories[cat]; }

/** "4/5 (80%)" plus the change since the previous finished run. */
function passCell(cur, prev) {
  if (!cur || !cur.graded) return '—';
  const delta = prev && prev.graded && cur.passRate !== null && prev.passRate !== null ? Math.round((cur.passRate - prev.passRate) * 100) : null;
  return `${cur.passed}/${cur.graded} (${pct0(cur.passRate)})${delta ? ` <span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</span>` : ''}`;
}

window.loadEvals = async function loadEvals() {
  const status = document.getElementById('evalStatus');
  try {
    evalData = await fetch('/api/evals').then(r => r.json());
  } catch {
    status.innerHTML = '<div class="card score-reason">Could not load the evaluation suite.</div>';
    return;
  }
  const btn = document.getElementById('evalRunBtn');
  if (!evalData.enabled) {
    status.innerHTML = '<div class="card score-reason">Evals are off for this deployment. Add an <code>"evals"</code> section to the deploy config and re-run the deploy.</div>';
    btn.disabled = true;
    return;
  }
  const running = evalData.running || (evalData.runs.find(r => r.status === 'running') || {}).run_id;
  btn.disabled = Boolean(running);
  btn.textContent = running ? 'Running…' : 'Run evals';
  const accuracyCases = evalData.cases.filter(c => c.category === 'accuracy' && c.enabled).length;
  status.innerHTML = `<div class="card eval-note">
    ${running ? `<div class="eval-progress"><span class="dot"></span><span id="evalProgressText">Evaluation running…</span></div>` : ''}
    <div class="score-reason">Accuracy asks up to <b>${evalData.maxAccuracyCases}</b> of the ${accuracyCases} enabled ground-truth questions per run (each uses the query engine and the judge${evalData.judge && evalData.judge.model ? `, ${esc(evalData.judge.model)}` : ''}).
    Guardrail cases use only the classifier model; routing cases only the router model; policy cases use no model at all.${evalData.guardrailsOn ? '' : ' <b>Guardrails are off</b>, so those cases are reported as n/a.'}</div></div>`;

  renderEvalKpis();
  renderEvalRuns();
  renderEvalCases();
  const target = evalSelectedRun || running || (evalData.runs[0] && evalData.runs[0].run_id);
  if (target) loadEvalRun(target);
  else document.querySelector('#evalResultsTable tbody').innerHTML = '<tr><td colspan="7">No runs yet. Choose the categories and press Run evals.</td></tr>';
  if (running) pollRun(running);
};

function renderEvalKpis() {
  const done = evalData.runs.filter(r => r.status === 'done');
  const [cur, prev] = done;
  const k = document.getElementById('evalKpis');
  k.innerHTML = '';
  if (!cur) { k.innerHTML = '<div class="card score-reason">No finished runs yet.</div>'; return; }
  const a = catSummary(cur, 'accuracy'), g = catSummary(cur, 'guardrail'), p = catSummary(cur, 'policy'), ro = catSummary(cur, 'routing');
  const pa = catSummary(prev, 'accuracy');
  const trend = (now, before) => {
    if (now === null || now === undefined || before === null || before === undefined) return '';
    const d = Math.round((now - before) * 100);
    return d ? ` · ${d > 0 ? '▲' : '▼'}${Math.abs(d)} vs previous` : ' · same as previous';
  };
  k.appendChild(kpiCard('Accuracy', a && a.graded ? pct0(a.passRate) : '—', a ? `${a.passed}/${a.graded} ground-truth questions passed${trend(a.passRate, pa && pa.passRate)}` : 'Not in this run',
    a && a.passRate !== null ? (a.passRate >= 0.8 ? 'good' : 'warn') : null));
  k.appendChild(kpiCard('Correctness', a ? pct0(a.correctness) : '—', 'Ground-truth figures matched'));
  k.appendChild(kpiCard('Faithfulness', a ? pct0(a.faithfulness) : '—', a ? `Relevance ${pct0(a.relevance)} · Completeness ${pct0(a.completeness)}` : ''));
  k.appendChild(kpiCard('Guardrails', g && g.graded ? pct0(g.passRate) : '—', g ? `${g.passed}/${g.graded} red-team and false-positive cases` : 'Not in this run',
    g && g.passRate !== null ? (g.passRate >= 0.9 ? 'good' : 'warn') : null));
  k.appendChild(kpiCard('Policy checks', p && p.graded ? pct0(p.passRate) : '—', p ? `${p.passed}/${p.graded} answer-wording cases` : 'Not in this run',
    p && p.passRate !== null ? (p.passRate >= 0.9 ? 'good' : 'warn') : null));
  k.appendChild(kpiCard('Routing', ro && ro.graded ? pct0(ro.passRate) : '—', ro ? `${ro.passed}/${ro.graded} conversations routed as expected` : 'Not in this run',
    ro && ro.passRate !== null ? (ro.passRate >= 0.9 ? 'good' : 'warn') : null));
}

function renderEvalRuns() {
  const tbody = document.querySelector('#evalRunsTable tbody');
  tbody.innerHTML = '';
  const done = evalData.runs;
  done.forEach((r, i) => {
    const prev = done.slice(i + 1).find(x => x.status === 'done');
    const a = catSummary(r, 'accuracy');
    const ai = (r.config && r.config.ai) || {};
    const tr = document.createElement('tr');
    tr.className = 'turn-row' + (r.run_id === evalSelectedRun ? ' sel' : '');
    tr.innerHTML = `<td>${new Date(r.started_at).toLocaleString()}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${esc(r.started_by || '')}</td>
      <td>${r.status === 'running' ? `<span class="chip warn">running ${r.completed}/${r.total}</span>` : r.status === 'done' ? '<span class="chip ok">done</span>' : '<span class="chip bad">failed</span>'}</td>
      <td>${passCell(a, catSummary(prev, 'accuracy'))}</td>
      <td>${a ? pct0(a.correctness) : '—'}</td><td>${a ? pct0(a.faithfulness) : '—'}</td><td>${a ? pct0(a.relevance) : '—'}</td>
      <td>${passCell(catSummary(r, 'guardrail'), catSummary(prev, 'guardrail'))}</td>
      <td>${passCell(catSummary(r, 'policy'), catSummary(prev, 'policy'))}</td>
      <td>${passCell(catSummary(r, 'routing'), catSummary(prev, 'routing'))}</td>
      <td class="score-reason" style="white-space:normal;min-width:220px">${esc([ai.judge && ai.judge.model && `Judge ${ai.judge.model}`, ai.guardrails && ai.guardrails.model && `Guard ${ai.guardrails.model}`].filter(Boolean).join(' · ') || '—')}</td>`;
    tr.addEventListener('click', () => loadEvalRun(r.run_id));
    tbody.appendChild(tr);
  });
  if (!done.length) tbody.innerHTML = '<tr><td colspan="10">No runs yet.</td></tr>';
}

async function loadEvalRun(runId) {
  evalSelectedRun = runId;
  document.querySelectorAll('#evalRunsTable tr.sel').forEach(t => t.classList.remove('sel'));
  const data = await fetch(`/api/evals/runs/${runId}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!data) return;
  document.getElementById('evalResultsFor').textContent = `· run of ${new Date(data.run.started_at).toLocaleString()}`;
  const tbody = document.querySelector('#evalResultsTable tbody');
  tbody.innerHTML = '';
  data.results.forEach(r => {
    const d = r.details || {};
    const s = r.scores || {};
    const tr = document.createElement('tr');
    tr.className = 'turn-row';
    tr.innerHTML = `<td>${esc(CAT_LABELS[r.category] || r.category)}</td>
      <td style="max-width:360px;white-space:${r.category === 'routing' ? 'pre-line' : 'normal'}">${esc(r.question)}</td>
      <td>${esc(expectedLabel(r.category, r.expected === 'ground truth' ? null : r.expected))}</td>
      <td>${passChip(r.passed)}</td>
      <td style="max-width:300px;white-space:normal" class="score-reason">${esc(r.outcome || '')}</td>
      <td>${r.latency_ms ? fmtMs(r.latency_ms) : '—'}</td><td>▸</td>`;
    const detail = document.createElement('tr');
    detail.className = 'turn-detail-row';
    const td = document.createElement('td');
    td.colSpan = 7;
    const rt = d.route;
    const routePill = rt ? `<div class="turn-detail-block"><div class="lab">Router</div><div class="retry-pills">${[
      `${rt.destination === 'platform' ? 'Lens MLOps guide' : 'Data'} · ${rt.mode === 'agent' ? 'deep' : 'quick'}${rt.escalated ? ' · fresh' : ''}`,
      `Intent: ${rt.intent}`, rt.confidence !== null && rt.confidence !== undefined ? `${Math.round(rt.confidence * 100)}% sure` : null,
      `By ${rt.method === 'ai' ? esc(rt.model || 'the router model') : 'the word rules'}`, rt.fallback ? `Model unavailable: ${esc(rt.fallback)}` : null,
      ...(rt.rules || []).map(x => 'Rule: ' + x),
    ].filter(Boolean).map(x => `<span class="retry-pill">${esc(x)}</span>`).join('')}</div>${rt.standalone && rt.standalone !== r.question.split('\n').pop() ? `<div class="score-reason">Sent as: “${esc(rt.standalone)}”</div>` : ''}${rt.reason ? `<div class="score-reason">${esc(rt.reason)}</div>` : ''}</div>` : '';
    const scorePills = Object.entries(s).filter(([, v]) => v !== null && v !== undefined)
      .map(([k2, v]) => `<span class="retry-pill">${esc(k2)} ${pct0(v)}</span>`).join('');
    td.innerHTML = `<div class="turn-detail">
      ${scorePills ? `<div class="retry-pills">${scorePills}</div>` : ''}
      ${routePill}
      ${d.answerPreview ? `<div class="turn-detail-block"><div class="lab">Answer</div><div class="answer-box">${esc(d.answerPreview.replace(/\*\*/g, '').replace(/\[\[chart:[^\]]+\]\]/g, '[chart]'))}</div></div>` : ''}
      ${d.judge ? `<div class="turn-detail-block"><div class="lab">Judge</div>${renderJudge(d.judge)}</div>` : ''}
      ${(d.sql || []).length ? `<div class="turn-detail-block"><div class="lab">SQL the engine ran</div>${d.sql.map(q => `<div class="codebox">${esc(q)}</div>`).join('')}</div>` : ''}
      ${d.expectedSql ? `<div class="turn-detail-block"><div class="lab">Ground-truth SQL</div><div class="codebox">${esc(d.expectedSql)}</div></div>` : ''}
      ${d.events ? `<div class="turn-detail-block"><div class="lab">Checks that fired</div>${renderGuardEvents(d.events)}</div>` : ''}
      ${d.sentText || d.output ? `<div class="turn-detail-block"><div class="lab">After the checks</div><div class="answer-box">${esc(d.sentText || d.output)}</div></div>` : ''}
      ${d.error || d.expectedSqlError ? `<div class="turn-detail-block"><div class="lab">Error</div><div class="codebox">${esc(d.error || d.expectedSqlError)}</div></div>` : ''}
    </div>`;
    detail.appendChild(td);
    tr.addEventListener('click', () => { detail.classList.toggle('open'); tr.lastElementChild.textContent = detail.classList.contains('open') ? '▾' : '▸'; });
    tbody.appendChild(tr);
    tbody.appendChild(detail);
  });
  if (!data.results.length) tbody.innerHTML = `<tr><td colspan="7">${data.run.status === 'running' ? 'Results appear here as each case finishes.' : 'No results.'}</td></tr>`;
  renderEvalRuns();
}

function renderEvalCases() {
  const tbody = document.querySelector('#evalCasesTable tbody');
  tbody.innerHTML = '';
  evalData.cases.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" ${c.enabled ? 'checked' : ''} aria-label="Include this case"></td>
      <td>${esc(CAT_LABELS[c.category] || c.category)}</td>
      <td style="max-width:380px;white-space:${c.category === 'routing' ? 'pre-line' : 'normal'}">${esc(c.question)}</td>
      <td>${esc(expectedLabel(c.category, c.expected, c.has_ground_truth))}</td>
      <td>${esc(c.source)}</td>
      <td class="score-reason" style="white-space:normal">${esc(c.notes || '')}</td>`;
    tr.querySelector('input').addEventListener('change', async (e) => {
      const r = await fetch(`/api/evals/cases/${c.case_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }),
      });
      if (r.ok) c.enabled = e.target.checked; else e.target.checked = c.enabled;
    });
    tbody.appendChild(tr);
  });
  if (!evalData.cases.length) tbody.innerHTML = '<tr><td colspan="6">No cases yet. Run the deploy\'s lakebase step to seed them.</td></tr>';
}

function pollRun(runId) {
  clearInterval(evalPoll);
  evalPoll = setInterval(async () => {
    const data = await fetch(`/api/evals/runs/${runId}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!data) return;
    const t = document.getElementById('evalProgressText');
    if (t) t.textContent = `Evaluation running: ${data.run.completed} of ${data.run.total} cases done…`;
    if (evalSelectedRun === runId) loadEvalRun(runId);
    if (data.run.status !== 'running') {
      clearInterval(evalPoll);
      evalPoll = null;
      loadEvals();
    }
  }, 3000);
}

document.getElementById('evalRunBtn').addEventListener('click', async () => {
  const categories = [...document.querySelectorAll('.eval-cat:checked')].map(c => c.value);
  if (!categories.length) { alert('Choose at least one category.'); return; }
  const btn = document.getElementById('evalRunBtn');
  btn.disabled = true;
  const r = await fetch('/api/evals/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { alert(data.error || 'Could not start the evaluation.'); btn.disabled = false; return; }
  evalSelectedRun = data.runId;
  loadEvals();
});
