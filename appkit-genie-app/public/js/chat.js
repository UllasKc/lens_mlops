// AI Assistant: Copilot-style conversations, per-question mode, rendered markdown and charts.
// Modes, named for what the user gets: Auto (the default: picks per question), Quick answer
// (the engine's Chat mode) and Deep analysis (its Agent mode). Answers are only ever 'chat' or 'agent'.

const MODE_NAMES = { agent: 'Deep analysis', chat: 'Quick answer', auto: 'Auto' };
const modeName = m => MODE_NAMES[m] || MODE_NAMES.chat;

/**
 * Auto: the server decides per question (an AI classifier, or the word rule where the
 * deployment turns the model off; see server/lib/autoMode.ts). This local copy of the word
 * rule is only the fallback if that call fails.
 */
function autoModeLocal(question) {
  const t = String(question).toLowerCase();
  if (t.split(/\s+/).filter(Boolean).length > 22) return 'agent';
  if (/\b(why|how (can|could|should|do|would) we|what should|recommend|strateg(y|ies)|improve|root cause|driving|compare|comparison|analy[sz]e|analysis|investigat|prioriti[sz]e|plan|explain|aggressive|impact|trade-?off|what (is|are) (causing|behind))\b/.test(t)) return 'agent';
  const lookup = /^\s*(which|what (is|are|was|were)|show|list|give me|how (many|much)|top \d+|count)\b/.test(t);
  return !lookup && /\b(opportunit|drivers?\b)/.test(t) ? 'agent' : 'chat';
}
async function autoRoute(question) {
  try {
    const r = await fetch('/api/chat/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, sessionId: activeSessionId || undefined }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.mode === 'agent' || d.mode === 'chat') return d;
  } catch { /* fall back to the local rule */ }
  return { mode: autoModeLocal(question), method: 'rules', reason: 'local rule (the router was unavailable)' };
}

// Auto is the default; a person's own choice is remembered (new key, so everyone starts on Auto).
let currentMode = readPref('lensmlops.mode.v3', 'auto');
let activeSessionId = null;
let sessions = [];
let sending = false;

const msgsEl = document.getElementById('chatMsgs');
const inputEl = document.getElementById('chatInput');
const sendBtn = document.getElementById('chatSend');
const sessionListEl = document.getElementById('sessionList');
const emptyEl = document.getElementById('chatEmpty');
const titleEl = document.getElementById('chatTitle');

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- mode switch

const modeBtn = document.getElementById('modeBtn');
const modeMenu = document.getElementById('modeMenu');

function setMode(mode) {
  currentMode = ['chat', 'agent', 'auto'].includes(mode) ? mode : 'auto';
  writePref('lensmlops.mode.v3', currentMode);
  document.getElementById('modeLabel').textContent = modeName(currentMode);
  document.getElementById('modeSelect').dataset.mode = currentMode;
  modeMenu.querySelectorAll('.mode-opt').forEach(o => o.setAttribute('aria-selected', String(o.dataset.mode === currentMode)));
}
function openModeMenu(open) {
  modeMenu.hidden = !open;
  modeBtn.setAttribute('aria-expanded', String(open));
}
modeBtn.addEventListener('click', (e) => { e.stopPropagation(); openModeMenu(modeMenu.hidden); });
modeMenu.querySelectorAll('.mode-opt').forEach(o => o.addEventListener('click', () => { setMode(o.dataset.mode); openModeMenu(false); inputEl.focus(); }));
document.addEventListener('click', (e) => { if (!e.target.closest('#modeSelect')) openModeMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openModeMenu(false); });
setMode(currentMode);

// ---------------------------------------------------------------- composer

sendBtn.addEventListener('click', () => sendMessage());
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
inputEl.addEventListener('input', autosize);
function autosize() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'; }

// ---------------------------------------------------------------- starter questions
// One list feeds both the empty-state tiles and the side panel shown once a
// conversation has started. Each question is checked against the live data
// for a strong answer before being listed. The server owns the list
// (it also pre-warms the answer cache with it); these copies are only a
// fallback until /api/chat/suggestions answers.
let STARTERS = [
  { mode: 'chat', label: 'How healthy is the model fleet?', q: 'How healthy is our model fleet right now?' },
  { mode: 'chat', label: 'Models drifting this week', q: 'Which models are showing drift this week?' },
  { mode: 'chat', label: 'Total cost savings this week', q: 'What is total cost savings this week?' },
  { mode: 'agent', label: "What's happening with MDL_061? Explain the spike", q: "What's happening with MDL_061? Explain the spike." },
  { mode: 'agent', label: 'Which models need action first, and why?', q: 'Which models need action first, and why? Rank them by business risk.' },
  { mode: 'agent', label: 'Daily executive briefing', q: 'Give me a daily executive briefing: top incident, biggest savings, worst-performing model.' },
];

// The side panel shows the six starters plus four more (five per mode), also
// checked against the live data for strong answers.
let MORE_SUGGESTIONS = [
  { mode: 'chat', label: 'Models with confidence below 60% right now', q: 'Which models have confidence below 60% right now?' },
  { mode: 'chat', label: 'False positive rate by model version', q: 'Which model version has the highest false positive rate?' },
  { mode: 'agent', label: 'Accuracy of the Furnace models', q: 'Compare predicted vs actual accuracy across all Furnace models' },
  { mode: 'agent', label: 'Where the value came from, and how concentrated it is', q: 'Which business units and incidents delivered the value, and how concentrated is it?' },
];

// Quick-start prompts (welcome screen and the prompts panel) and the categorized
// question library. The server owns the lists; these are fallbacks until it answers.
let QUICK_START = [
  { icon: 'alert', category: 'Health', title: 'Models needing action', desc: 'Drift, low confidence and false alarms, ranked', mode: 'agent', q: 'Which models need action first, and why? Rank them by business risk.' },
  { icon: 'brief', category: 'Executive', title: 'Daily executive briefing', desc: 'Top incident, biggest savings, worst model', mode: 'agent', q: 'Give me a daily executive briefing: top incident, biggest savings, worst-performing model.' },
];
let LIBRARY = [];
const QS_ICONS = {
  gap: '<path d="M4 18l6-6 4 4 6-8"/><path d="M15 8h5v5"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  promise: '<path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="5" y="11" width="14" height="10" rx="2"/>',
  cash: '<path d="M3 7h18v10H3z"/><circle cx="12" cy="12" r="2.5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>',
  brief: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
};
let libCategory = null;

function askFromPanel(q, mode) {
  if (sending) return;
  setSuggestOpen(false, false);
  sendMessage(q, { standalone: true, preset: true, mode });
}

function quickCard(s, cls) {
  const b = document.createElement('button');
  b.className = cls;
  b.title = s.q;
  b.innerHTML = `<span class="qs-top"><svg viewBox="0 0 24 24" aria-hidden="true">${QS_ICONS[s.icon] || QS_ICONS.gap}</svg><span class="qs-cat">${esc(s.category)}</span></span>
    <span class="qs-title">${esc(s.title)}</span><span class="qs-desc">${esc(s.desc)}</span>`;
  b.addEventListener('click', () => askFromPanel(s.q, s.mode));
  return b;
}

function renderSuggestions() {
  const grid = document.getElementById('starterGrid');
  grid.innerHTML = '';
  QUICK_START.forEach(s => grid.appendChild(quickCard(s, 'starter qs-card')));
  const qs = document.getElementById('qsGrid');
  qs.innerHTML = '';
  QUICK_START.forEach(s => qs.appendChild(quickCard(s, 'qs-mini')));
  renderLibrary();
}

function renderLibrary() {
  const chips = document.getElementById('libChips');
  const list = document.getElementById('libList');
  if (!LIBRARY.length) { chips.innerHTML = ''; list.innerHTML = ''; return; }
  if (!libCategory || !LIBRARY.some(c => c.category === libCategory)) libCategory = LIBRARY[0].category;
  chips.innerHTML = LIBRARY.map(c => `<button class="chip-btn${c.category === libCategory ? ' on' : ''}" data-c="${esc(c.category)}">${esc(c.category)}</button>`).join('');
  chips.querySelectorAll('.chip-btn').forEach(b => b.addEventListener('click', () => { libCategory = b.dataset.c; renderLibrary(); }));
  list.innerHTML = '';
  (LIBRARY.find(c => c.category === libCategory)?.items || []).forEach(it => {
    const b = document.createElement('button');
    b.className = 'lib-item';
    b.innerHTML = `<span>${esc(it.q)}</span><small>(${esc(it.tag)}) · ${modeName(it.mode)}</small>`;
    b.addEventListener('click', () => askFromPanel(it.q, it.mode));
    list.appendChild(b);
  });
}
renderSuggestions();
/**
 * The Assistant's own requests wait until the page the person is looking at has loaded
 * (the browser is idle), unless they open the Assistant first.
 */
function whenIdle(fn) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(go, { timeout: 5000 });
  document.querySelector('.tabs button[data-tab="assistant"]')?.addEventListener('click', go, { once: true });
}
whenIdle(() => fetch('/api/chat/suggestions').then(r => r.ok ? r.json() : null).then(d => {
  if (!d) return;
  if (Array.isArray(d.starters) && d.starters.length) { STARTERS = d.starters; MORE_SUGGESTIONS = d.more || []; }
  if (Array.isArray(d.quickStart) && d.quickStart.length) QUICK_START = d.quickStart;
  if (Array.isArray(d.library)) LIBRARY = d.library;
  renderSuggestions();
}).catch(() => {}));

// Layout like ChatGPT / Copilot: the conversation list folds away (minimized by default,
// remembered per person; an overlay on small screens) and suggested questions open on demand.
const chatWrapEl = document.getElementById('chatWrap');
const suggestPanel = document.getElementById('suggestPanel');
const suggestBtn = document.getElementById('suggestBtn');
const sideScrim = document.getElementById('sideScrim');
const narrow = () => window.matchMedia('(max-width: 900px)').matches;

function setSideOpen(open, remember = true) {
  chatWrapEl.classList.toggle('side-open', open);
  document.getElementById('sideToggle').setAttribute('aria-expanded', String(open));
  document.getElementById('sideOpen').hidden = open;
  sideScrim.hidden = !(open && narrow());
  if (remember && !narrow()) writePref('lensmlops.sideOpen', open ? '1' : '0');
}
document.getElementById('sideToggle').addEventListener('click', () => setSideOpen(!chatWrapEl.classList.contains('side-open')));
document.getElementById('sideOpen').addEventListener('click', () => setSideOpen(true));
// Collapsed rail, like ChatGPT: new chat, search and chats each open the list where it's needed.
document.getElementById('searchMini').addEventListener('click', () => { setSideOpen(true); setTimeout(() => document.getElementById('sessionSearch').focus(), 220); });
document.getElementById('chatsMini').addEventListener('click', () => setSideOpen(true));
sideScrim.addEventListener('click', () => { setSideOpen(false, false); setSuggestOpen(false); });
setSideOpen(!narrow() && readPref('lensmlops.sideOpen', '1') === '1', false);   // open by default on desktop, like Copilot

function setSuggestOpen(open, remember = true) {
  if (remember) writePref('lensmlops.promptsOpen', open ? '1' : '0');
  suggestPanel.hidden = !open;
  chatWrapEl.classList.toggle('suggest-open', open);
  suggestBtn.setAttribute('aria-expanded', String(open));
  suggestBtn.classList.toggle('on', open);
  if (narrow()) sideScrim.hidden = !open;
}
suggestBtn.addEventListener('click', () => setSuggestOpen(suggestPanel.hidden));
document.getElementById('suggestClose').addEventListener('click', () => setSuggestOpen(false));
document.getElementById('resetBtn').addEventListener('click', () => { if (!sending) newChat(); });
document.getElementById('pdfBtn2').addEventListener('click', () => document.getElementById('pdfBtn').click());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !suggestPanel.hidden) setSuggestOpen(false); });

// Conversation search: filters the list as you type.
document.getElementById('sessionSearch').addEventListener('input', () => renderSessionList());

document.getElementById('newSessionBtn').addEventListener('click', () => { newChat(); if (narrow()) setSideOpen(false, false); });
document.getElementById('newSessionMini').addEventListener('click', newChat);

window.askAssistant = function askAssistant(question, mode) {
  if (window.showTab) window.showTab('assistant');
  if (sending) { inputEl.value = question; autosize(); return; }   // don't interrupt a running answer
  newChat();
  sendMessage(question, { standalone: true, preset: true, mode: mode === 'chat' ? 'chat' : 'agent' });
};

// The welcome line uses the person's first name once it's known.
function paintGreeting() {
  const g = document.getElementById('emptyGreeting');
  if (g) g.textContent = window.userFirstName ? `Hi ${window.userFirstName}, what would you like to know?` : 'What would you like to know?';
}
document.addEventListener('lens:user', paintGreeting);
paintGreeting();

function newChat() {
  activeSessionId = null;
  msgsEl.innerHTML = '';
  titleEl.textContent = 'New conversation';
  updateEmpty();
  renderSessionList();
  inputEl.focus();
}

// Empty conversation: starter tiles in the middle. Once it has messages: the same
// questions move to the collapsible panel on the right.
function updateEmpty() {
  const started = msgsEl.children.length > 0;
  emptyEl.classList.toggle('hidden', started);
  document.querySelector('#tab-assistant .chat').classList.toggle('is-empty', !started);
  // The welcome screen already shows the quick-start prompts; once a conversation starts the
  // prompts panel opens beside it on wide screens (unless the person closed it).
  if (!narrow() && window.innerWidth >= 1400) setSuggestOpen(started && readPref('lensmlops.promptsOpen', '1') === '1', false);
  document.getElementById('pdfBtn').hidden = !started;
}

// ---------------------------------------------------------------- sessions

async function loadSessions() {
  sessions = await fetch('/api/chat/sessions').then(r => r.json());
  renderSessionList();
}

function dayGroup(ts) {
  const d = new Date(ts), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = (start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff <= 7) return 'Previous 7 days';
  if (diff <= 30) return 'Previous 30 days';
  return 'Older';
}

function renderSessionList() {
  sessionListEl.innerHTML = '';
  const term = (document.getElementById('sessionSearch').value || '').trim().toLowerCase();
  const list = term ? sessions.filter(s => (s.title || '').toLowerCase().includes(term)) : sessions;
  if (!list.length) {
    sessionListEl.innerHTML = `<div class="sessions-empty">${term ? 'No conversations match.' : 'Your conversations will appear here.'}</div>`;
    return;
  }
  let lastGroup = null;
  list.forEach(s => {
    const g = dayGroup(s.updated_at);
    if (g !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'sgroup';
      h.textContent = g;
      sessionListEl.appendChild(h);
      lastGroup = g;
    }
    const div = document.createElement('div');
    div.className = 'session-item' + (s.session_id === activeSessionId ? ' on' : '');
    div.title = s.title || 'Untitled conversation';
    div.innerHTML = `<span class="stitle">${esc(s.title || 'Untitled conversation')}</span>
      <button class="sact" data-act="rename" title="Rename">✎</button>
      <button class="sact" data-act="delete" title="Delete">🗑</button>`;
    div.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'rename') { e.stopPropagation(); startRename(div, s); }
      else if (act === 'delete') { e.stopPropagation(); deleteSession(s); }
      else if (!div.querySelector('input')) { openSession(s.session_id); if (narrow()) setSideOpen(false, false); }
    });
    sessionListEl.appendChild(div);
  });
}

function startRename(div, s) {
  const span = div.querySelector('.stitle');
  const input = document.createElement('input');
  input.value = s.title || '';
  span.replaceWith(input);
  div.querySelectorAll('.sact').forEach(b => b.remove());
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (save && title && title !== s.title) {
      const r = await fetch(`/api/chat/sessions/${s.session_id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      });
      if (r.ok) {
        s.title = title;
        if (s.session_id === activeSessionId) titleEl.textContent = title;
      }
    }
    renderSessionList();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

async function deleteSession(s) {
  if (!confirm(`Delete "${s.title || 'Untitled conversation'}"? This can't be undone.`)) return;
  const r = await fetch(`/api/chat/sessions/${s.session_id}`, { method: 'DELETE' });
  if (!r.ok) return;
  sessions = sessions.filter(x => x.session_id !== s.session_id);
  if (s.session_id === activeSessionId) newChat();
  else renderSessionList();
}

async function openSession(id) {
  if (sending) return;
  activeSessionId = id;
  const session = sessions.find(s => s.session_id === id);
  titleEl.textContent = (session && session.title) || 'Untitled conversation';
  renderSessionList();
  msgsEl.innerHTML = '';
  const messages = await fetch(`/api/chat/sessions/${id}/messages`).then(r => r.json());
  if (activeSessionId !== id) return;
  let question = '';
  messages.forEach((m, i) => {
    if (m.role === 'user') { addUserBubble(m.content, m.mode); question = m.content; }
    else addAnswer(normalizeStored(m), {
      mode: m.mode, at: m.created_at, messageId: m.message_id, feedback: m.feedback,
      question, canRefresh: i === messages.length - 1, isLast: i === messages.length - 1, quality: m.quality,
    });
  });
  updateEmpty();
}

/** Stored messages carry the normalized answer in attachment_json (v2); older ones only text. */
function normalizeStored(m) {
  const a = m.attachment_json;
  if (a && a.version === 2) return a;
  return { mode: m.mode, text: m.content || '', charts: [] };
}

// ---------------------------------------------------------------- bubbles

function addRow(role) {
  const row = document.createElement('div');
  row.className = 'turnrow ' + role;
  if (role === 'bot') {
    // The Concentrix mark identifies the assistant's replies (also in the PDF, which captures these rows).
    const av = document.createElement('img');
    av.className = 'bot-avatar';
    av.src = '/img/cnx-mark.png';
    av.alt = '';
    row.appendChild(av);
  }
  const msg = document.createElement('div');
  msg.className = 'msg';
  if (role === 'bot') {
    // Answers are signed by the engine: "Lens Intelligence Engine".
    const col = document.createElement('div');
    col.className = 'bot-col';
    const name = document.createElement('div');
    name.className = 'bot-name';
    name.textContent = 'Lens Intelligence Engine';
    col.append(name, msg);
    row.appendChild(col);
  } else {
    row.appendChild(msg);
  }
  msgsEl.appendChild(row);
  updateEmpty();
  return msg;
}

function scrollToEnd() { msgsEl.scrollTop = msgsEl.scrollHeight; }

function addUserBubble(text) {
  const msg = addRow('user');
  msg.textContent = text;
  scrollToEnd();
}

function metaLine(mode, extra) {
  return `<div class="meta"><span class="tag ${mode}">${modeName(mode)}</span>${extra ? `<span>${esc(extra)}</span>` : ''}</div>`;
}

function addAnswer(answer, opts) {
  const msg = addRow('bot');
  renderAnswer(msg, answer, opts);
  return msg;
}

function renderAnswer(msg, answer, opts) {
  const mode = answer.mode || opts.mode || 'chat';
  // A table with no rows is never shown (answers saved before the server dropped them).
  const charts = (answer.charts || []).filter(c => (c.rows || []).length);
  const placed = new Set();
  const body = document.createElement('div');
  body.className = 'md';
  body.innerHTML = renderMarkdown(answer.text || (charts.length ? '' : 'No answer text was returned.'));
  body.querySelectorAll('[data-chart]').forEach(ph => {
    const c = charts.find(x => x.id === ph.dataset.chart);
    if (c) { ph.replaceWith(renderViz(c)); placed.add(c.id); } else ph.remove();
  });
  charts.filter(c => !placed.has(c.id)).forEach(c => body.appendChild(renderViz(c)));
  msg.innerHTML = '';
  msg.appendChild(body);

  // Guardrails: a blocked question shows its reason as the answer; notes (e.g. removed PII) stay visible.
  const blocked = Boolean(answer.guard && answer.guard.blocked);
  if (blocked) msg.classList.add('guard-blocked');
  ((answer.guard && answer.guard.notices) || []).forEach(n => {
    msg.insertAdjacentHTML('beforeend', `<div class="guard-note"><span aria-hidden="true">🛡</span> ${esc(n)}</div>`);
  });
  // Questions about Lens MLOps itself are answered from the platform guide, not the model data.
  if (answer.platform) {
    msg.insertAdjacentHTML('beforeend', `<div class="platform-note"><span aria-hidden="true">📘</span> From the Lens MLOps platform guide, not the model data. Ask about the data any time.</div>`);
  }

  // One row of actions under the answer, like Copilot: copy, 👍, 👎, regenerate, details.
  const actions = document.createElement('div');
  actions.className = 'ans-actions';
  msg.appendChild(actions);
  const iconBtn = (cls, title, svg) => {
    const b = document.createElement('button');
    b.className = 'act ' + cls;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;
    actions.appendChild(b);
    return b;
  };
  const copyBtn = iconBtn('act-copy', 'Copy', '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>');
  copyBtn.addEventListener('click', async () => {
    const plain = (answer.text || '').replace(/\[\[chart:[^\]]+\]\]/g, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
    try { await navigator.clipboard.writeText(plain); } catch {
      const ta = document.createElement('textarea'); ta.value = plain; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    copyBtn.classList.add('done'); copyBtn.title = 'Copied';
    setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.title = 'Copy'; }, 1500);
  });
  if (opts.messageId && !blocked) addFeedback(actions, opts.messageId, opts.feedback);
  if (opts.question && (opts.live || opts.isLast) && !blocked) {
    const regen = iconBtn('act-regen', 'Regenerate', '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>');
    regen.addEventListener('click', () => {
      if (sending) return;
      const answerMode = answer.mode === 'agent' ? 'agent' : 'chat';
      // A cached answer is replaced in place by a live one; a live answer is asked again.
      if (answer.cache && opts.messageId) sendMessage(opts.question, { refreshOf: opts.messageId, target: msg, mode: answerMode });
      else sendMessage(opts.question, { mode: answerMode });
    });
  }
  const detailsBtn = iconBtn('act-details', 'Details: quality, sources and how this answer was made',
    '<span class="det-dot" aria-hidden="true"></span><span>Details</span><svg class="det-caret" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>');
  detailsBtn.setAttribute('aria-expanded', 'false');

  const details = document.createElement('div');
  details.className = 'ans-details';
  details.hidden = true;
  msg.appendChild(details);
  detailsBtn.addEventListener('click', () => {
    details.hidden = !details.hidden;
    detailsBtn.setAttribute('aria-expanded', String(!details.hidden));
    detailsBtn.classList.toggle('on', !details.hidden);
  });

  const when = opts.at ? new Date(opts.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const took = opts.latencyMs && !answer.cache ? `${(opts.latencyMs / 1000).toFixed(0)}s` : '';
  details.insertAdjacentHTML('beforeend', metaLine(mode, [took, when].filter(Boolean).join(' · ')));
  const metaEl = details.lastElementChild;
  if (answer.cache) addCacheNote(msg, metaEl, answer, { ...opts, canRefresh: false });
  if (answer.steps && answer.steps.length) {
    const d = document.createElement('details');
    d.className = 'steps';
    const n = answer.steps.filter(s => s.kind === 'sql').length;
    d.innerHTML = `<summary>How the analysis worked it out · ${answer.steps.length} steps, ${n} ${n === 1 ? 'query' : 'queries'}</summary>
      <ol>${answer.steps.map(s => `<li>${s.kind === 'sql' ? '🔎 ' : s.kind === 'viz' ? '📊 ' : ''}${esc(s.text)}${s.sql ? `<br><code>${esc(s.sql.replace(/\s+/g, ' ').slice(0, 300))}</code>` : ''}</li>`).join('')}</ol>`;
    details.appendChild(d);
  }
  if (opts.messageId && !blocked) addTrustBar(msg, metaEl, opts);

  if (opts.live || opts.isLast) addFollowups(msg, answer.suggestions, answer.mode);
}

// ---------------------------------------------------------------- trust: quality, sources, checks

const METRIC_LABELS = { faithfulness: 'Faithfulness', relevance: 'Relevance', completeness: 'Completeness', safety: 'Safety' };
const CHECK_LABELS = {
  pii: 'Personal details', profanity: 'Offensive language', prompt_injection: 'Prompt injection', off_topic: 'Off-topic',
  causal_claim: 'Causal claim about an action', forecast: 'Forecast beyond the data', roi_claim: 'ROI figure', probability: 'Probability claim',
};

/**
 * The trust bar under an answer: its quality score (or "checking" while the
 * judge runs, which is after the answer arrives), the data sources it used and
 * any guardrail that acted. Click for the full "How this answer was made" view.
 * Answers scoring below the configured threshold also get a visible warning.
 */
function addTrustBar(msg, metaEl, opts) {
  const bar = document.createElement('div');
  bar.className = 'trust';
  metaEl.parentNode.insertBefore(bar, metaEl);
  const paint = (q) => {
    if (!q) { bar.remove(); return; }
    const chips = [];
    if (q.status === 'done' && q.score !== null) {
      const pct = Math.round(q.score * 100);
      const tone = pct >= 85 ? 'ok' : q.score >= q.warnBelow ? 'mid' : 'low';
      const word = tone === 'ok' ? 'Verified' : tone === 'mid' ? 'Mostly verified' : 'Low confidence';
      chips.push(`<button class="trust-chip ${tone}" data-open title="Faithfulness: how well the figures and claims match the data the queries returned${q.judgeModel ? ` (scored by ${esc(q.judgeModel)})` : ''}">${tone === 'low' ? '⚠' : '✓'} ${word} · ${pct}%</button>`);
    } else if (q.status === 'pending') {
      chips.push('<span class="trust-chip pending"><span class="dot"></span>Checking accuracy…</span>');
    }
    if (q.sources && q.sources.length) {
      chips.push(`<span class="trust-chip" title="${esc(q.sources.join(', '))}">📊 ${q.sources.length} certified data source${q.sources.length === 1 ? '' : 's'}</span>`);
    }
    const acted = (q.guard || []).filter(g => g.action !== 'off');
    if (acted.some(g => g.check === 'pii' && g.action === 'redact')) chips.push('<span class="trust-chip">🛡 Personal details masked</span>');
    else if (acted.length) chips.push(`<span class="trust-chip" title="${esc(acted.map(g => CHECK_LABELS[g.check] || g.check).join(', '))}">🛡 ${acted.length} safety check${acted.length === 1 ? '' : 's'} applied</span>`);
    else chips.push('<span class="trust-chip">🛡 Safety checks passed</span>');
    chips.push('<button class="trust-link" data-open>How this answer was made ›</button>');
    chips.push('<button class="trust-link" data-obs>Inspect in Observability ›</button>');
    bar.innerHTML = chips.join('');
    bar.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openTrace(opts.messageId)));
    bar.querySelectorAll('[data-obs]').forEach(b => b.addEventListener('click', () => window.openTraceForMessage && window.openTraceForMessage(opts.messageId)));
    const dot = msg.querySelector('.det-dot');
    if (dot) {
      dot.className = 'det-dot ' + (q.status === 'done' && q.score !== null ? (q.score >= 0.85 ? 'ok' : q.score >= q.warnBelow ? 'mid' : 'low') : q.status === 'pending' ? 'pending' : '');
      dot.title = q.status === 'done' && q.score !== null ? `Verified ${Math.round(q.score * 100)}%` : q.status === 'pending' ? 'Checking accuracy…' : '';
    }

    // Low confidence: say so where it can't be missed, with what couldn't be verified.
    msg.querySelectorAll('.lowconf').forEach(n => n.remove());
    if (q.status === 'done' && q.score !== null && q.score < q.warnBelow) {
      const items = [...(q.unsupported || []), ...(q.missing || []).map(m => `the figure ${m}`)].slice(0, 4);
      const box = document.createElement('div');
      box.className = 'lowconf';
      box.innerHTML = `<b>⚠ Some of this answer couldn't be verified against the data</b> (${Math.round(q.score * 100)}%). Please double-check before acting.` +
        (items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
      const det = msg.querySelector('.ans-details');
      if (det) det.insertBefore(box, det.firstChild); else msg.appendChild(box);
    }
  };
  const load = async (tries) => {
    if (!document.body.contains(bar)) return;   // the answer was closed or deleted
    try {
      const r = await fetch(`/api/chat/messages/${opts.messageId}/trace`);
      // Just after the answer appears its log entry may not be written yet; try again shortly.
      if (r.status === 404 && tries > 0) { setTimeout(() => load(tries - 1), 1500); return; }
      if (!r.ok) return paint(null);
      const q = (await r.json()).quality;
      paint(q);
      if (q.status === 'pending' && tries > 0 && document.body.contains(bar)) setTimeout(() => load(tries - 1), 4000);
    } catch { /* the bar is a nice-to-have */ }
  };
  if (opts.quality) {
    paint(opts.quality);
    if (opts.quality.status === 'pending') setTimeout(() => load(25), 4000);
  } else {
    paint({ status: opts.judging ? 'pending' : 'n/a', guard: [], sources: [] });
    load(25);
  }
}

const traceDialog = document.getElementById('traceDialog');
document.getElementById('traceClose').addEventListener('click', () => traceDialog.close());
traceDialog.addEventListener('click', (e) => { if (e.target === traceDialog) traceDialog.close(); });

/** "How this answer was made": quality scores, data sources and SQL, safety checks, request trace and AI usage. */
async function openTrace(messageId) {
  const body = document.getElementById('traceBody');
  body.innerHTML = '<div class="score-reason">Loading…</div>';
  traceDialog.showModal();
  let t;
  try {
    const r = await fetch(`/api/chat/messages/${messageId}/trace`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    t = await r.json();
  } catch {
    body.innerHTML = '<div class="score-reason">Could not load the details for this answer.</div>';
    return;
  }
  if (t.pending) {
    body.innerHTML = '<div class="score-reason">This answer is still being recorded. Try again in a few seconds.</div>';
    return;
  }
  const q = t.quality;
  const pctOf = v => (v === null || v === undefined ? null : Math.round(v * 100));
  const meter = (label, v) => {
    const pct = pctOf(v);
    const tone = pct === null ? '' : pct >= 85 ? 'ok' : pct >= 70 ? 'mid' : 'low';
    return `<div class="meter"><span class="meter-l">${label}</span><span class="meter-bar"><span class="${tone}" style="width:${pct ?? 0}%"></span></span><span class="meter-v">${pct === null ? '—' : pct + '%'}</span></div>`;
  };
  const quality = q.status === 'done'
    ? `${meter('Faithfulness (overall)', q.score)}${q.metrics ? Object.keys(METRIC_LABELS).filter(k => k !== 'faithfulness').map(k => meter(METRIC_LABELS[k], q.metrics[k])).join('') : ''}
       <div class="score-reason">${q.numbers && q.numbers.checked ? `${q.numbers.found} of ${q.numbers.checked} figures found in the query results. ` : ''}${q.reason ? esc(q.reason) : ''}${q.judgeModel ? ` <span class="muted">Scored by ${esc(q.judgeModel)}${q.reused ? ', when this answer was first generated' : ''}.</span>` : ''}</div>
       ${(q.unsupported || []).length ? `<div class="score-reason"><b>Not supported by the data:</b><ul>${q.unsupported.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
       ${(q.missing || []).length ? `<div class="score-reason"><b>Figures not found in the results:</b> ${esc(q.missing.join(', '))}</div>` : ''}`
    : `<div class="score-reason">${q.status === 'pending' ? 'The quality check is still running; it takes a few seconds after the answer arrives.' : q.status === 'off' ? 'The answer-quality judge is turned off for this deployment.' : 'This answer was not scored.'}</div>`;
  const guard = (t.guard || []).length
    ? `<ul class="checklist">${t.guard.map(g => `<li><b>${esc(g.stage === 'input' ? 'Question' : 'Answer')}:</b> ${esc(CHECK_LABELS[g.check] || g.check)} → ${esc(g.action)}${g.by === 'model' ? ' (AI classifier)' : ''}</li>`).join('')}</ul>`
    : '<div class="score-reason">Every check passed: personal details, offensive language, prompt injection and off-topic on the question; personal details, offensive language and policy wording (forecasts, causal uplift, probabilities) on the answer.</div>';
  const sources = (q.sources || []).length
    ? `<div class="retry-pills">${q.sources.map(s => `<span class="retry-pill">${esc(s)}</span>`).join('')}</div>` : '<div class="score-reason">No data was queried.</div>';
  const queries = (t.queries || []).map((x, i) => `<details class="trace-sql"><summary>${i + 1}. ${esc(x.title || 'Query')}${x.rows != null ? ` · ${fmtNum(x.rows)} rows` : ''}</summary><pre>${esc(x.sql || '')}</pre></details>`).join('');
  const usage = (t.tokens || []).length
    ? `<table class="mini"><thead><tr><th>Step</th><th>Model</th><th>Input</th><th>Output</th></tr></thead><tbody>${t.tokens.map(k =>
        `<tr><td>${esc(featureLabel(k.feature))}</td><td>${esc(k.model)}</td><td>${fmtNum(k.input)}</td><td>${fmtNum(k.output)}</td></tr>`).join('')}</tbody></table>
       ${t.cost !== null ? `<div class="score-reason">Estimated cost: $${t.cost.toFixed(4)}</div>` : ''}`
    : '<div class="score-reason">No AI model calls were needed.</div>';
  body.innerHTML = `
    <div class="trace-q">“${esc(t.question)}”<span>${modeName(t.mode)} · ${fmtMs(t.latencyMs)}${t.cache && t.cache.hit ? ' · answered from cache' : ''}</span></div>
    <section><h3>Answer quality</h3>${quality}</section>
    <section><h3>Data used</h3>${sources}${queries}</section>
    <section><h3>Safety checks</h3>${guard}</section>
    <section><h3>Request trace</h3>${renderWaterfall(t.trace, t.latencyMs, t.timeline)}</section>
    <section><h3>AI usage</h3>${usage}</section>`;
}

/** Suggested next questions as buttons, above the trust bar (they can arrive just after the answer).
 *  A click is sent in the mode of the answer it follows, with no Auto or platform routing. */
function addFollowups(msg, list, mode) {
  msg.querySelectorAll('.followups').forEach(n => n.remove());
  if (!list || !list.length) return;
  const f = document.createElement('div');
  f.className = 'followups';
  list.slice(0, 3).forEach(q => {
    const b = document.createElement('button');
    b.className = 'followup';
    b.textContent = q;
    b.addEventListener('click', () => sendMessage(q, { preset: true, mode: mode === 'agent' ? 'agent' : 'chat' }));
    f.appendChild(b);
  });
  msg.appendChild(f);
}

/** Cached answers say so, with when they were generated, and can be re-asked live. */
function addCacheNote(msg, metaEl, answer, opts) {
  const g = new Date(answer.cache.generatedAt);
  const sameDay = g.toDateString() === new Date().toDateString();
  const at = (sameDay ? '' : g.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ') +
    g.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const note = document.createElement('span');
  note.className = 'cache-note';
  const similar = answer.cache.similarTo;
  note.title = similar
    ? `Your question matched an earlier one closely (${(similar.similarity * 100).toFixed(1)}% similar, same products, buckets and figures), so its answer was reused. Refresh gets a fresh live answer.`
    : 'This question was answered recently on the same data, so the saved answer was reused. Refresh gets a fresh live answer.';
  note.innerHTML = `<span class="cache-bolt" aria-hidden="true">⚡</span>Answered from cache` +
    (similar ? ` · similar to “${esc(similar.question.length > 70 ? similar.question.slice(0, 70) + '…' : similar.question)}”` : '') +
    ` · generated ${esc(at)}`;
  metaEl.appendChild(note);
  if (opts.messageId && opts.question && opts.canRefresh !== false) {
    const b = document.createElement('button');
    b.className = 'cache-refresh';
    b.textContent = '↻ Refresh';
    b.title = 'Get a fresh live answer';
    b.addEventListener('click', () => {
      if (sending) return;
      // Re-ask in the same mode as the cached answer, without changing the person's mode setting.
      sendMessage(opts.question, { refreshOf: opts.messageId, target: msg, mode: answer.mode || opts.mode || 'chat' });
    });
    metaEl.appendChild(b);
  }
}

/** 👍/👎 on an answer: saved in the app (a 👎 asks why, for the review queue). Click again to clear. */
function addFeedback(metaEl, messageId, current) {
  const box = document.createElement('span');
  box.className = 'fb';
  const thumb = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/></svg>';
  box.innerHTML = `<span class="fb-note"></span>
    <button class="fb-up" data-r="up" title="Helpful" aria-label="Helpful">${thumb}</button>
    <button class="fb-down" data-r="down" title="Not helpful" aria-label="Not helpful">${thumb}</button>`;
  let rating = current === 1 ? 'up' : current === -1 ? 'down' : null;
  const paintFb = () => box.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.r === rating);
    b.setAttribute('aria-pressed', String(b.dataset.r === rating));
  });
  paintFb();
  // Optimistic: the button lights up at once and only reverts if saving fails.
  const submit = async (next, extra = {}) => {
    const before = rating;
    rating = next;
    paintFb();
    box.querySelector('.fb-note').textContent = next ? 'Thanks for the feedback' : '';
    try {
      const r = await fetch(`/api/chat/messages/${messageId}/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: next, ...extra }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch {
      rating = before;
      paintFb();
      box.querySelector('.fb-note').textContent = "Couldn't save that, please try again";
    }
  };
  box.querySelectorAll('.fb-up,.fb-down').forEach(b => b.addEventListener('click', () => {
    const next = rating === b.dataset.r ? null : b.dataset.r;
    if (next === 'down') askWhy(box, (reason, comment) => submit('down', { reason, comment }));
    else submit(next);
  }));
  metaEl.appendChild(box);
}

const FB_REASONS = [['wrong_numbers', 'Wrong numbers'], ['wrong_data', 'Wrong products, buckets or filters'], ['not_answered', "Didn't answer my question"], ['unclear', 'Hard to understand'], ['other', 'Something else']];

/** A small popover under 👎: pick a reason, optionally add a note. Sending without a reason still records the 👎. */
function askWhy(box, done) {
  document.querySelectorAll('.fb-why').forEach(n => n.remove());
  const pop = document.createElement('div');
  pop.className = 'fb-why';
  pop.innerHTML = `<div class="fb-why-h">What was wrong?</div>
    <div class="fb-why-opts">${FB_REASONS.map(([v, l]) => `<button data-v="${v}">${esc(l)}</button>`).join('')}</div>
    <textarea rows="2" maxlength="500" placeholder="Anything else? (optional)"></textarea>
    <div class="fb-why-bar"><button class="fb-why-cancel">Cancel</button><button class="fb-why-send">Send</button></div>`;
  let reason = null;
  pop.querySelectorAll('.fb-why-opts button').forEach(b => b.addEventListener('click', () => {
    reason = b.dataset.v;
    pop.querySelectorAll('.fb-why-opts button').forEach(x => x.classList.toggle('on', x === b));
  }));
  pop.querySelector('.fb-why-cancel').addEventListener('click', () => pop.remove());
  pop.querySelector('.fb-why-send').addEventListener('click', () => { pop.remove(); done(reason, pop.querySelector('textarea').value.trim()); });
  box.appendChild(pop);
}

// ---------------------------------------------------------------- sending

async function ensureSession() {
  if (activeSessionId) return activeSessionId;
  const s = await fetch('/api/chat/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json());
  activeSessionId = s.session_id;
  return activeSessionId;
}

async function sendMessage(preset, opts = {}) {
  const text = (preset || inputEl.value).trim();
  if (!text || sending) return;
  if (window.offerNotifications) window.offerNotifications();
  const isAuto = !opts.mode && currentMode === 'auto';
  let mode = opts.mode || (isAuto ? 'chat' : currentMode);
  sending = true;
  sendBtn.disabled = true;
  if (!opts.refreshOf) inputEl.value = '';
  autosize();
  document.querySelectorAll('.followups, .cache-refresh').forEach(f => f.remove());

  // A refresh re-asks the same question and replaces the cached answer in place.
  let thinking = opts.target;
  if (!thinking) {
    addUserBubble(text);
    thinking = addRow('bot');
  }
  thinking.classList.add('thinking');
  let route = null;
  if (isAuto) {
    thinking.innerHTML = '<div class="tline"><span class="dot"></span><span>Choosing quick answer or deep analysis…</span></div>';
    route = await autoRoute(text);
    mode = route.mode;
  }
  const started = Date.now();
  const steps = [];
  let status = mode === 'agent' ? 'Planning the analysis…' : 'Understanding the question…';
  // Deep analysis takes minutes: show progress against a typical run, and say they can carry on working.
  const typical = mode === 'agent' ? 120 : 20;
  const paint = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const prog = Math.min(95, Math.round(100 * (1 - Math.exp(-secs / (typical * 0.6)))));
    thinking.innerHTML = `<div class="tline"><span class="dot"></span><span>${esc(status)}</span><span class="tclock">${clock}</span></div>` +
      `<div class="tprog"><span style="width:${prog}%"></span></div>` +
      (steps.length ? `<div class="steps-live">${steps.slice(-5).map(s => `<div>${esc(s)}</div>`).join('')}</div>` : '') +
      (mode === 'agent' ? `<div class="thint">Deep analysis usually takes 1–3 minutes. You can switch tabs; you'll get a notification when it's ready.</div>` : '') +
      metaLine(mode);
  };
  paint();
  const timer = setInterval(paint, 1000);
  scrollToEnd();

  let answer = null;
  let errorText = null;
  let latencyMs = null;
  let savedId = null;
  let sentSessionId = null;
  let judging = false;
  let rendered = false;
  let errorBusy = false;
  try {
    const sessionId = await ensureSession();
    sentSessionId = sessionId;
    const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, mode, auto: Boolean(route), standalone: Boolean(opts.standalone), preset: Boolean(opts.preset), refreshOf: opts.refreshOf || undefined }),
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        let type = 'message';
        const lines = [];
        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) lines.push(line.slice(5).trim());
        }
        if (!lines.length) continue;
        let data;
        try { data = JSON.parse(lines.join('\n')); } catch { continue; }

        if (type === 'progress') {
          if (data.kind === 'status') status = humanizeStatus(data.text);
          else if (data.kind === 'sql') { status = 'Running queries…'; steps.push('🔎 ' + data.text); }
          else if (data.kind === 'viz') { status = 'Building a chart…'; steps.push('📊 ' + data.text); }
          else if (data.kind === 'reasoning') { status = 'Reasoning…'; if (data.text) steps.push('💭 ' + data.text.slice(0, 140)); }
          else if (data.kind === 'writing') status = 'Writing the answer…';
          else if (data.kind === 'notice') { status = data.text; steps.push('⏳ ' + data.text); }
          paint();
          scrollToEnd();
        } else if (type === 'answer') {
          answer = data;
        } else if (type === 'saved') {
          savedId = data.messageId;
          // Show the answer now; follow-up suggestions and the session name may still be on their way.
          if (answer && !rendered) {
            clearInterval(timer);
            thinking.classList.remove('thinking');
            renderAnswer(thinking, answer, { mode, latencyMs: Date.now() - started, at: new Date(), live: true, messageId: savedId, question: text, judging: !answer.cache });
            rendered = true;
            scrollToEnd();
          }
        } else if (type === 'followups') {
          if (answer) answer.suggestions = data.questions;
          if (rendered) { addFollowups(thinking, data.questions, mode); scrollToEnd(); }
        } else if (type === 'error') {
          errorText = data.error;
          errorBusy = Boolean(data.busy);
        } else if (type === 'session_title') {
          titleEl.textContent = data.title;
        } else if (type === 'done') {
          latencyMs = data.latencyMs;
          judging = Boolean(data.judging);
        }
      }
    }
  } catch (err) {
    console.error(err);
    errorText = 'Could not reach the assistant.';
  }

  clearInterval(timer);
  thinking.classList.remove('thinking');
  if (rendered) {
    // already on screen
  } else if (answer) {
    renderAnswer(thinking, answer, { mode, latencyMs, at: new Date(), live: true, messageId: savedId, question: text, judging });
  } else {
    thinking.classList.add('failed');
    // Say what went wrong in plain words, and offer a one-click retry.
    thinking.innerHTML = `<div class="fail-h">${errorBusy ? 'The analysis service is busy right now.' : "Sorry, that question couldn't be answered."}</div>
      <div class="fail-b">${errorBusy ? 'Too many analyses are running at once. Please try again in a minute.'
        : mode === 'chat' ? 'Try rephrasing it, or choose Deep analysis for a fuller investigation.' : 'Try again, ask a narrower question, or choose Quick answer.'}</div>
      <button class="fail-retry">↻ Try again</button>` + metaLine(mode, errorText ? 'error' : '');
    thinking.querySelector('.fail-retry').addEventListener('click', () => {
      if (sending) return;
      thinking.closest('.turnrow').previousElementSibling?.remove();
      thinking.closest('.turnrow').remove();
      sendMessage(text, { mode });
    });
    console.warn('Assistant error:', errorText);
  }
  scrollToEnd();
  sending = false;
  sendBtn.disabled = false;
  loadSessions().catch(console.error);
  if (window.notifyAnswerReady) {
    window.notifyAnswerReady({ sessionId: sentSessionId, question: text, ok: Boolean(answer && !(answer.guard && answer.guard.blocked)) });
  }
}

function humanizeStatus(status) {
  const map = {
    SUBMITTED: 'Sending the question…',
    FETCHING_METADATA: 'Looking up the data…',
    FILTERING_CONTEXT: 'Understanding the question…',
    ASKING_AI: 'Writing the SQL…',
    PENDING_WAREHOUSE: 'Starting the warehouse…',
    EXECUTING_QUERY: 'Running the query…',
    COMPLETED: 'Finishing up…',
  };
  return map[status] || 'Working…';
}

// ---------------------------------------------------------------- markdown

/** Small, safe markdown renderer: everything is escaped first. */
function renderMarkdown(src) {
  const text = stripCitations(String(src)).replace(/\\([[\]])/g, '$1').replace(/\r/g, '');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const chart = line.trim().match(/^\[\[chart:([^\]]+)\]\]$/);
    if (chart) { out.push(`<div data-chart="${esc(chart[1])}"></div>`); i++; continue; }
    if (/^```/.test(line.trim())) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="mdtable"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const isItem = l => (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(l);
      const items = [];
      let n = 0;
      for (;;) {
        // Agent answers often put a blank line between items; that's still one list.
        while (i < lines.length && isItem(lines[i])) {
          const num = ordered ? parseInt(lines[i].match(/\d+/)[0], 10) : 0;
          // Keep the author's numbering, but count on when every item is "1." (auto-numbering).
          n = ordered && num > n ? num : n + 1;
          items.push(`<li${ordered ? ` value="${n}"` : ''}>${inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`);
          i++;
        }
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j > i && j < lines.length && isItem(lines[j])) { i = j; continue; }
        break;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*•]|\d+[.)])\s+|\[\[chart:)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}

/** Citation links point into the workspace, which app users can't open; removed here
 * too for answers stored before the server stripped them. */
function stripCitations(s) {
  return s
    .replace(/[ \t]*\\?\[\\?\[\d+\\?\]\([^)\s]*\)\\?\]/g, '') // [[1](url)]
    .replace(/[ \t]*\\?\[\\?\[\d+\\?\]\\?\]\([^)\s]*\)/g, '') // [[1]](url)
    .replace(/[ \t]*\\?\[\\?\[\d+\\?\]\\?\]?\([^)\s]*$/, '') // a citation cut off by truncation
    // Agent mode's newer marker, e.g. *[unrendered:citation[01f1…]]*, sometimes several in a row
    .replace(/[ \t]*[*_]?\\?\[unrendered:citation\\?\[[^\]\s]*\\?\]\\?\][*_]?/g, '')
    .replace(/[ \t]*[*_]?\\?\[unrendered:citation[^\n]*$/, '') // cut off by truncation
    .replace(/[ \t]+([.,;:])/g, '$1');
}

function inline(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return t;
}

// ---------------------------------------------------------------- charts

const NUMERIC_TYPES = /^(DOUBLE|FLOAT|DECIMAL|INT|INTEGER|BIGINT|LONG|SHORT|SMALLINT|TINYINT|BYTE|NUMBER)/i;
const PALETTE = ['#1D4ED8', '#9333EA', '#0E9384', '#D97706', '#DC2626', '#4338CA'];

function analyse(chart) {
  const cols = chart.columns.map((c, i) => {
    const vals = chart.rows.map(r => r[i]).filter(v => v !== null && v !== '');
    const numeric = NUMERIC_TYPES.test(c.type || '') || (vals.length > 0 && vals.every(v => !isNaN(Number(v))));
    const nums = numeric ? vals.map(Number) : [];
    const max = nums.length ? Math.max(...nums.map(Math.abs)) : 0;
    const ratio = numeric && max <= 1.5 && /pct|percent|rate|ratio|achievement|share|conversion/i.test(c.name);
    const idLike = /(^|_)(id|key|token)$/i.test(c.name);
    const dateLike = /DATE|TIMESTAMP/i.test(c.type || '') || /date|month|day|week/i.test(c.name);
    return { name: c.name, i, numeric: numeric && !idLike, ratio, max, dateLike };
  });
  return cols;
}

function fmtCell(v, col) {
  if (v === null || v === undefined || v === '') return '—';
  if (!col.numeric) return esc(v);
  const n = Number(v);
  if (col.ratio) return (n * 100).toFixed(1) + '%';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return Number.isInteger(n) ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function compact(n) {
  const a = Math.abs(n);
  // One decimal below 10 (1.5K, 2.5M) so neighbouring axis ticks don't all read "1K"; trailing ".0" dropped.
  const unit = (v, s) => (Math.abs(v) < 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(0)) + s;
  if (a >= 1e9) return unit(n / 1e9, 'B');
  if (a >= 1e6) return unit(n / 1e6, 'M');
  if (a >= 1e3) return unit(n / 1e3, 'K');
  return String(Math.round(n * 100) / 100);
}

/** Numeric columns whose name the chart title spells out (most of the name's words appear in the title). */
function titledColumns(title, nums) {
  const words = new Set(String(title || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  if (/%/.test(title || '')) ['pct', 'percent', 'percentage'].forEach(w => words.add(w));
  const minor = new Set(['to', 'of', 'per', 'by', 'and', 'the', 'a', 'in', 'mtd']);
  return nums.filter(c => {
    const parts = c.name.toLowerCase().split(/[^a-z0-9]+/).filter(p => p && !minor.has(p));
    return parts.length && parts.filter(p => words.has(p)).length / parts.length >= 0.66;
  });
}

function chartPlan(chart) {
  const cols = analyse(chart);
  const labels = cols.filter(c => !c.numeric);
  const nums = cols.filter(c => c.numeric);
  if (chart.rows.length < 2 || !nums.length || !labels.length) return null;
  // The engine names a chart ("Cost to Collect by Strategy") but doesn't say which columns
  // to plot, so plot the columns its title names; otherwise the first measures as before.
  const focus = titledColumns(chart.title, nums);
  const big = (focus.length ? focus : nums).filter(c => !c.ratio);
  const ratios = (focus.length ? focus : nums).filter(c => c.ratio);
  let bars, line = null;
  if (focus.length) {
    bars = (big.length ? big : ratios).slice(0, 3);
    line = big.length ? ratios[0] || null : null;
  } else if (big.length) {
    const top = big[0].max || 1;
    bars = big.filter(c => c.max >= top / 25 && c.max <= top * 25).slice(0, 3);
    line = ratios[0] || null;
  } else {
    bars = ratios.slice(0, 3);
  }
  const labelCols = labels.slice(0, 2);
  const timeSeries = labelCols[0].dateLike && chart.rows.length > 2;
  return { labelCols, bars, line, timeSeries, cols };
}

function renderViz(chart) {
  const plan = chartPlan(chart);
  const wrap = document.createElement('div');
  wrap.className = 'viz';
  const views = [plan && 'Chart', 'Table', chart.sql && 'SQL'].filter(Boolean);
  wrap.innerHTML = `<div class="viz-head"><div class="viz-title" title="${esc(chart.title)}">${esc(chart.title)}</div>
    <div class="viz-tabs">${views.map((v, k) => `<button class="${k === 0 ? 'on' : ''}" data-view="${v}">${v}</button>`).join('')}</div></div>
    <div class="viz-body"></div>${chart.truncated ? '<div class="viz-note">Showing the first 500 rows.</div>' : ''}`;
  const bodyEl = wrap.querySelector('.viz-body');
  let chartObj = null;
  const show = (view) => {
    wrap.querySelectorAll('.viz-tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    if (chartObj) { chartObj.destroy(); chartObj = null; }
    if (view === 'Chart') {
      bodyEl.innerHTML = '<div class="cv"><canvas></canvas></div>';
      chartObj = drawChart(bodyEl.querySelector('canvas'), chart, plan);
    } else if (view === 'Table') {
      const cols = plan ? plan.cols : analyse(chart);
      bodyEl.innerHTML = `<div class="tablewrap"><table><thead><tr>${cols.map(c => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${
        chart.rows.map(r => `<tr>${cols.map(c => `<td>${fmtCell(r[c.i], c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else {
      bodyEl.innerHTML = `<pre>${esc(chart.sql)}</pre>`;
    }
  };
  wrap.querySelector('.viz-tabs').addEventListener('click', (e) => { if (e.target.dataset.view) show(e.target.dataset.view); });
  // Draw once attached so Chart.js can measure the container.
  requestAnimationFrame(() => show(views[0]));
  return wrap;
}

function drawChart(canvas, chart, plan) {
  if (typeof Chart === 'undefined') return null;
  const rows = plan.timeSeries ? chart.rows : chart.rows.slice(0, 25);
  const labels = rows.map(r => plan.labelCols.map(c => r[c.i] ?? '—').join(' · '));
  const horizontal = !plan.timeSeries && (rows.length > 10 || labels.some(l => l.length > 18));
  const datasets = plan.bars.map((c, k) => ({
    type: plan.timeSeries ? 'line' : 'bar',
    label: c.name.replace(/_/g, ' '),
    data: rows.map(r => (r[c.i] === null ? null : Number(r[c.i]) * (c.ratio && !plan.line ? 100 : 1))),
    backgroundColor: PALETTE[k] + (plan.timeSeries ? '33' : 'CC'),
    borderColor: PALETTE[k],
    borderWidth: plan.timeSeries ? 2 : 0,
    borderRadius: 4,
    tension: .25,
    yAxisID: 'y',
    xAxisID: 'x',
  }));
  const ratioOnly = !plan.line && plan.bars.every(c => c.ratio);
  if (plan.line && !horizontal) {
    datasets.push({
      type: 'line', label: plan.line.name.replace(/_/g, ' ') + ' (%)',
      data: rows.map(r => (r[plan.line.i] === null ? null : Number(r[plan.line.i]) * 100)),
      borderColor: '#D97706', backgroundColor: '#D97706', pointRadius: 3, borderWidth: 2, yAxisID: 'y2', xAxisID: 'x',
    });
  }
  const valueAxis = { beginAtZero: !ratioOnly, ticks: { callback: v => (ratioOnly ? v + '%' : compact(v)), font: { size: 10 } }, grid: { color: '#EEF1F5' } };
  const catAxis = { ticks: { font: { size: 10 }, autoSkip: true, maxRotation: 40 }, grid: { display: false } };
  const scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
  if (plan.line && !horizontal) scales.y2 = { position: 'right', ticks: { callback: v => v + '%', font: { size: 10 } }, grid: { display: false } };
  return new Chart(canvas, {
    type: plan.timeSeries ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: datasets.length > 1, labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.dataset.yAxisID === 'y2' || ratioOnly ? ctx.parsed[horizontal ? 'x' : 'y'].toFixed(1) + '%' : Number(ctx.parsed[horizontal ? 'x' : 'y']).toLocaleString()}` } },
      },
      scales,
    },
  });
}

updateEmpty();
whenIdle(() => loadSessions().catch(console.error));
