// ---------------------------------------------------------------- Responsible AI page
// What the assistant is for, which AI models it uses and when, the data it
// answers from, the protections in force, how quality is measured, how data is
// handled, and its limits. The models, checks and numbers come live from the
// app's configuration and logs, so the page always matches what is deployed.

let raiLoaded = false;

window.loadResponsibleAi = async function loadResponsibleAi() {
  const el = document.getElementById('raiBody');
  let t;
  try {
    t = await fetch('/api/ai/transparency').then(r => r.json());
  } catch {
    if (!raiLoaded) el.innerHTML = '<div class="card score-reason">Could not load this page.</div>';
    return;
  }
  raiLoaded = true;
  const c = t.config || {};
  const g = c.guardrails;
  const on = (x) => (x ? '<span class="chip ok">On</span>' : '<span class="chip neutral">Off</span>');
  const act = (a) => ({ block: 'Blocked', redact: 'Removed', warn: 'Warned', flag: 'Flagged for review', off: 'Off' }[a] || a);
  const tot = { ...(t.guardCounts || {}), ...(t.totals || {}) };
  const ev = t.latestEval && t.latestEval.summary && t.latestEval.summary.categories;

  const models = [
    ['Answering questions', 'Lens query engine: turns the question into SQL over the certified semantic model, runs it, and explains the result', 'Every question not answered from the cache', 'Always on'],
    ['Screening questions', g && g.model ? g.model : 'Pattern checks only', 'Before a question reaches the query engine', on(g)],
    ['Matching similar questions', c.semanticCache ? c.semanticCache.model : '—', 'To reuse a recent answer to the same question', on(c.semanticCache)],
    ['Checking answer quality', c.judge ? (c.judge.model || 'Numbers check only') : '—', 'After each answer, without delaying it', on(c.judge)],
    ['Choosing quick or deep (Auto)', c.autoMode && c.autoMode.method === 'ai' ? c.autoMode.model : 'Word rule, no model', 'When Auto is selected, before the question is sent', on(true)],
    ['Answering questions about the platform', c.platformHelp ? (c.platformHelp.method === 'ai' ? c.platformHelp.model : 'Platform guide text, no model') : '—', 'Only for questions about Lens MLOps itself (tabs, navigation, how answers are checked), answered from the platform guide', on(c.platformHelp)],
    ['Remembering the conversation', c.memory ? (c.memory.model ? c.memory.model : 'Short digest, no model') : '—', c.memory ? `Every ${c.memory.compactEvery} questions in a chat, older turns are summarised so follow-ups keep their context` : 'Off', on(c.memory)],
    ['Suggesting follow-up questions', c.followUps ? c.followUps.model : '—', 'After an answer, when the engine suggests none', on(c.followUps)],
    ['Naming conversations', c.titles ? c.titles.model : 'From the first question', 'Once per conversation', on(true)],
  ];
  const checks = g ? [
    ['Question', 'Personal details (emails, phone, card, Aadhaar, PAN, SSN, IBAN)', g.input.pii],
    ['Question', 'Offensive or abusive language', g.input.profanity],
    ['Question', 'Prompt injection and jailbreak attempts', g.input.prompt_injection],
    ['Question', 'Off-topic requests', g.input.off_topic],
    ['Answer', 'Personal details', g.output.pii],
    ['Answer', 'Offensive language', g.output.profanity],
    ['Answer', 'Unsupported claims: forecasts, causal claims about actions such as retraining, ROI figures, probabilities', g.output.policy_checks],
  ] : [];
  const evalLine = (cat, label) => ev && ev[cat] && ev[cat].graded
    ? `<li><b>${label}:</b> ${ev[cat].passed} of ${ev[cat].graded} passed (${Math.round(ev[cat].passRate * 100)}%)</li>` : '';

  el.innerHTML = `
  <div class="card rai-hero">
    <div class="eyebrow">Purpose and intended use</div>
    <p>Lens MLOps answers questions about a fleet of production ML models in plain language, from governed and certified data. It helps leaders and reliability engineers see which models are healthy, drifting or losing confidence, how good their alerts are, and what value they deliver. It <b>supports people's decisions</b>; it does not change, retrain or switch off any model, and it is not a forecasting tool.</p>
    <p class="score-reason">Answers are AI-generated. Every answer shows how well it was verified against the data, which data it used, and the exact SQL behind it.</p>
  </div>

  <div class="rai-grid">
    <div class="card">
      <h3>AI models and when they run</h3>
      <table class="mini rai-table"><thead><tr><th>Task</th><th>Model</th><th>When</th><th>Status</th></tr></thead><tbody>
      ${models.map(m => `<tr><td><b>${esc(m[0])}</b></td><td>${esc(m[1])}</td><td>${esc(m[2])}</td><td>${m[3] === 'Always on' ? '<span class="chip ok">Always on</span>' : m[3]}</td></tr>`).join('')}
      </tbody></table>
      <p class="score-reason">All models are served from the same secure data platform as the data, under its access controls. The app does not use questions or answers to train any model. Each optional model can be switched off in the deployment configuration.</p>
    </div>

    <div class="card">
      <h3>Data it answers from</h3>
      <p class="score-reason">Only the certified views and metric views below, read-only, through the app's own service identity. The data describes models, assets and sites; it holds no personal information.</p>
      <div class="retry-pills" style="margin-top:8px">${(t.sources || []).map(s => `<span class="retry-pill" title="${esc(s.comment || s.kind)}">${esc(s.name)}</span>`).join('') || '<span class="score-reason">The list of views is unavailable right now.</span>'}</div>
    </div>
  </div>

  <div class="rai-grid">
    <div class="card">
      <h3>Protections in force</h3>
      ${g ? `<table class="mini rai-table"><thead><tr><th>Checked</th><th>For</th><th>Action</th></tr></thead><tbody>
        ${checks.map(r => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td><td>${act(r[2])}</td></tr>`).join('')}</tbody></table>
        <p class="score-reason">So far: ${fmtNum(tot.blocked || 0)} question${tot.blocked === 1 ? '' : 's'} blocked and ${fmtNum(tot.redacted || 0)} with personal details removed, out of ${fmtNum((t.totals && t.totals.questions) || 0)}. Personal details are removed <b>before</b> a question is sent on or stored.</p>`
        : '<p class="score-reason">Guardrails are switched off in this deployment.</p>'}
    </div>

    <div class="card">
      <h3>How quality is measured</h3>
      <ul class="rai-list">
        <li><b>Every answer</b> is scored after it arrives: its figures are checked against the query results, and ${c.judge && c.judge.model ? esc(c.judge.model) : 'a judge model'} rates faithfulness, relevance, completeness and safety. Answers below ${c.judge ? Math.round((c.judge.warnBelow || 0.7) * 100) : 70}% carry a visible warning.</li>
        <li><b>Average faithfulness so far:</b> ${tot.avg_faithfulness ? Math.round(Number(tot.avg_faithfulness) * 100) + '%' : '—'} across ${fmtNum(tot.judged || 0)} scored answers.</li>
        <li><b>Evaluation suite</b> (ground-truth questions, red-team prompts, policy wording), run on demand:${t.latestEval ? ` latest run ${new Date(t.latestEval.finished_at).toLocaleString()}<ul>${evalLine('accuracy', 'Accuracy')}${evalLine('guardrail', 'Guardrails')}${evalLine('policy', 'Policy checks')}</ul>` : ' not run yet.'}</li>
        <li><b>People in the loop:</b> every 👎 asks why and goes to a review queue (${fmtNum(tot.reviewed || 0)} of ${fmtNum(tot.thumbs_down || 0)} reviewed); a reviewer can turn it into a new test case.</li>
      </ul>
    </div>
  </div>

  <div class="rai-grid">
    <div class="card">
      <h3>How data is handled</h3>
      <ul class="rai-list">
        <li>Everyone signs in with their organisation account; each person sees only their own conversations.</li>
        <li>Questions, answers and the usage log are kept in the app's own database, inside the same platform, for history and auditing. Personal details are removed before anything is stored.</li>
        <li>Deleting a conversation removes its messages; the monitoring log keeps the (already masked) question for audit.</li>
        <li>Observability shows administrators every question, the SQL that ran, the checks that fired and the quality score.</li>
      </ul>
    </div>
    <div class="card">
      <h3>Known limitations</h3>
      <ul class="rai-list">
        <li>Data is a single snapshot (as of 2026-09-15); it doesn't predict month-end results.</li>
        <li>Strategy comparisons show <b>observed differences</b> between matched segments, not the uplift a change would cause.</li>
        <li>AI can misread a question or make mistakes. Check the quality badge, and the SQL under "How this answer was made", before acting.</li>
        <li>Agent mode takes 1 to 3 minutes for multi-step analysis; Chat mode is faster for simple questions.</li>
      </ul>
    </div>
  </div>

  <div class="card">
    <h3>Alignment with responsible-AI frameworks</h3>
    <p class="score-reason">Designed around the principles of the NIST AI Risk Management Framework and the transparency expectations of the EU AI Act; this is a description of the design, not a certification.</p>
    <table class="mini rai-table"><thead><tr><th>Principle</th><th>How Lens MLOps meets it</th></tr></thead><tbody>
      <tr><td><b>Govern</b></td><td>Every AI feature is set per deployment, can be switched off, and every model is named on this page and in Observability.</td></tr>
      <tr><td><b>Map</b></td><td>Intended use, data sources and limitations are documented here; out-of-scope requests are detected.</td></tr>
      <tr><td><b>Measure</b></td><td>Per-answer quality scoring, an evaluation suite with ground truth and red-team cases, and run-over-run comparison.</td></tr>
      <tr><td><b>Manage</b></td><td>Guardrails on questions and answers, low-confidence warnings, a feedback review queue, and a full audit trail with request traces.</td></tr>
      <tr><td><b>Transparency</b></td><td>Users are told answers are AI-generated, and can see the data, SQL, checks and quality behind each one.</td></tr>
    </tbody></table>
  </div>`;
};
