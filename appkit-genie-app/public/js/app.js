// ---------- tab switching ----------
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('on'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
    btn.classList.add('on');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('on');
    document.body.classList.toggle('assistant-on', btn.dataset.tab === 'assistant');
    // Live view: refreshed when opened, unless it was loaded in the last minute (e.g. in the background).
    if (btn.dataset.tab === 'obs' && window.loadMonitoring) window.loadMonitoring({ maxAgeMs: 60_000 });
    if (btn.dataset.tab === 'explorer' && window.loadExplorer) window.loadExplorer();
    // Evals and Responsible AI are areas of Observability (opened from its area tabs).
    if (btn.dataset.tab === 'obs' && window.showObsPane) window.showObsPane(window.currentObsPane || 'traces');
  });
});

// ---------- formatting helpers ----------
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v).toLocaleString('en-US');
}
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Math.round(Number(n)).toLocaleString('en-US');
}
function fmtPct(n) {
  if (n === null || n === undefined || n === '') return '—';
  return (Number(n) * 100).toFixed(1) + '%';
}

function kpiCard(label, val, secondary, tone) {
  const div = document.createElement('div');
  div.className = 'card kpi' + (tone ? ' ' + tone : '');
  div.innerHTML = `<div class="lab">${label}</div><div class="val">${val}</div>` +
    (secondary ? `<div class="sec">${secondary}</div>` : '');
  return div;
}

// ---------- request trace (shared by the answer panel and Monitoring) ----------
const FEATURE_LABELS = {
  guardrails: 'Guardrail classifier', embeddings: 'Question embedding', judge: 'Answer-quality judge',
  follow_ups: 'Follow-up suggestions', auto_mode: 'Auto mode router', platform_help: 'Platform questions', memory: 'Conversation memory', empty_results: 'Empty-result notes', title: 'Session naming', other: 'Other',
};
function featureLabel(f) { return FEATURE_LABELS[f] || f; }

function fmtDur(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * A waterfall of the request's spans: each bar starts where that step started
 * and is as long as it took, so parallel work (the guardrail classifier running
 * alongside the cache lookups) and the query engine's own stages are visible.
 * Older answers without a trace fall back to their stage timeline.
 */
function renderWaterfall(spans, total, timeline) {
  const esc2 = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let list = (spans || []).filter(s => s.ms >= 0);
  if (!list.length && timeline && timeline.length) {
    let at = 0;
    list = timeline.filter(s => s.ms > 0).map(s => { const x = { name: s.stage, kind: 'engine', start: at, ms: s.ms }; at += s.ms; return x; });
  }
  if (!list.length) return '<div class="score-reason">No trace was recorded for this question.</div>';
  const end = Math.max(total || 0, ...list.map(s => s.start + s.ms), 1);
  return `<div class="wf">${list.map(s => {
    const left = (s.start / end) * 100;
    const width = Math.max((s.ms / end) * 100, 0.6);
    return `<div class="wf-row${s.parent ? ' child' : ''}" title="${esc2(s.name)}: ${fmtDur(s.ms)} (starts at ${fmtDur(s.start)})">
      <span class="wf-name">${esc2(s.name)}</span>
      <span class="wf-track"><span class="wf-bar k-${esc2(s.kind)}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span></span>
      <span class="wf-ms">${fmtDur(s.ms)}</span></div>`;
  }).join('')}</div>
  <div class="wf-legend"><span class="k-guardrail">Guardrails</span><span class="k-cache">Cache</span><span class="k-engine">Query engine</span><span class="k-model">AI models</span><span class="wf-total">Total ${fmtDur(total)}</span></div>`;
}

/** "ullas.kc@concentrix.com" -> "Ullas": used to greet people by name. */
function firstNameOf(email) {
  const local = String(email || '').split('@')[0].split(/[._-]/)[0].replace(/\d+$/, '');
  return local && !/^local$/i.test(local) ? local.charAt(0).toUpperCase() + local.slice(1) : '';
}
window.userFirstName = '';

async function loadUser() {
  try {
    const me = await fetch('/api/me').then(r => r.json());
    // Never greet with an email address (some directories return it as the name).
    const name = me.name && !me.name.includes('@') ? me.name : '';
    window.userFirstName = name.split(' ')[0] || firstNameOf(me.email);
    // One letter, like the Databricks account button, in the Concentrix colours.
    const letter = ((name || me.email || '?').trim()[0] || '?').toUpperCase();
    ['userAvatar', 'userAvatar2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = letter; });
    document.getElementById('userFullName').textContent = name || (me.email || '').split('@')[0];
    document.getElementById('userEmail').textContent = me.email || '';
    document.getElementById('userBtn').title = `${name}${name ? ' · ' : ''}${me.email || ''}`;
    const ws = document.getElementById('workspaceLink');
    if (me.workspaceUrl) { ws.href = me.workspaceUrl; ws.hidden = false; }
    document.getElementById('assistantUserGreeting').textContent = me.email ? `Signed in as ${me.email}` : '';
    document.dispatchEvent(new CustomEvent('lens:user', { detail: { firstName: window.userFirstName } }));
  } catch { /* non-fatal */ }
}

// ---------- account menu (top right): full name, email, log out ----------
const userBtn = document.getElementById('userBtn');
const userMenu = document.getElementById('userMenu');
const setUserMenu = (open) => { userMenu.hidden = !open; userBtn.setAttribute('aria-expanded', String(open)); };
userBtn.addEventListener('click', (e) => { e.stopPropagation(); setUserMenu(userMenu.hidden); });
document.addEventListener('click', (e) => { if (!e.target.closest('.user-bar')) setUserMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setUserMenu(false); });
// Databricks Apps can't end the platform sign-in, so Log out ends the Lens MLOps session in this
// browser: it clears this person's local preferences and shows a signed-out screen.
document.getElementById('logoutBtn').addEventListener('click', () => {
  setUserMenu(false);
  try { Object.keys(localStorage).filter(k => k.startsWith('lensmlops.')).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  document.body.classList.add('signed-out-on');
  document.getElementById('signedOut').hidden = false;
});
document.getElementById('signBackIn').addEventListener('click', () => { window.location.replace('/'); });

// Anything marked data-ask="<question>" (Command Center panels, priorities) opens the
// assistant and asks it, in the mode given by data-mode; data-tab-jump switches tabs.
document.addEventListener('click', (e) => {
  const ask = e.target.closest('[data-ask]');
  if (ask && window.askAssistant) { e.preventDefault(); window.askAssistant(ask.dataset.ask, ask.dataset.mode || 'agent'); return; }
  const jump = e.target.closest('[data-tab-jump]');
  if (jump) { e.preventDefault(); showTab(jump.dataset.tabJump); }
});

// Every "Ask Lens" control shows the exact question it will ask (and the mode) on hover or
// keyboard focus, so people know what they are asking before they click.
const askTip = document.createElement('div');
askTip.className = 'ask-tip';
askTip.setAttribute('role', 'tooltip');
askTip.hidden = true;
document.body.appendChild(askTip);
let askTipFor = null;
function showAskTip(el) {
  if (el.title) { el.dataset.titleSaved = el.title; el.removeAttribute('title'); }   // no second, native tooltip
  const mode = el.dataset.mode === 'chat' ? 'Quick answer' : 'Deep analysis';
  askTip.innerHTML = `<span class="ask-tip-k">Asks Lens · ${mode}</span><span class="ask-tip-q"></span>`;
  askTip.querySelector('.ask-tip-q').textContent = el.dataset.ask;
  askTip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = askTip.offsetWidth, h = askTip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const top = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
  askTip.style.left = left + 'px';
  askTip.style.top = top + 'px';
  askTip.classList.toggle('below', top > r.top);
  askTipFor = el;
}
function hideAskTip() { askTip.hidden = true; askTipFor = null; }
document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-ask]'); if (el && el !== askTipFor) showAskTip(el); else if (!el && askTipFor) hideAskTip(); });
document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-ask]'); if (el) showAskTip(el); });
document.addEventListener('focusout', hideAskTip);
window.addEventListener('scroll', hideAskTip, true);
document.addEventListener('click', hideAskTip, true);

function showTab(name) {
  const b = document.querySelector(`.tabs button[data-tab="${name}"]`);
  if (b) b.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.showTab = showTab;

loadUser();

// The assistant fills the screen below the top bar; keep its height in step with the bar.
const navEl = document.querySelector('.nav');
const setNavH = () => document.documentElement.style.setProperty('--nav-h', navEl.offsetHeight + 'px');
setNavH();
if (window.ResizeObserver) new ResizeObserver(setNavH).observe(navEl);
window.addEventListener('resize', setNavH);
