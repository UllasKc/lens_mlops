// ---------------------------------------------------------------- answer-ready notifications
// When an answer finishes and the person isn't looking at that chat:
//  - the tab is hidden  -> a browser notification (if allowed) and a "(1)" badge in the tab title
//  - another app tab or chat is open -> an in-app toast with a View button
// Browsers only let a page ask for notification permission after a click, so the
// app offers it once, with a small banner, the first time someone asks a question.

const BASE_TITLE = document.title;
let unseen = 0;

function readNotifyPref(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeNotifyPref(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

function setBadge(n) {
  unseen = n;
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}

function lookingAt(sessionId) {
  const onAssistant = document.getElementById('tab-assistant').classList.contains('on');
  return !document.hidden && onAssistant && activeSessionId === sessionId;
}

function openAnswer(sessionId) {
  window.focus();
  const tabBtn = document.querySelector('.tabs button[data-tab=assistant]');
  if (tabBtn && !document.getElementById('tab-assistant').classList.contains('on')) tabBtn.click();
  if (sessionId && activeSessionId !== sessionId) openSession(sessionId);
  setBadge(0);
}

function toastRegion() {
  let r = document.getElementById('toastRegion');
  if (!r) {
    r = document.createElement('div');
    r.id = 'toastRegion';
    r.className = 'toast-region';
    r.setAttribute('role', 'status');
    r.setAttribute('aria-live', 'polite');
    document.body.appendChild(r);
  }
  return r;
}

function showToast({ title, body, ok, onView }) {
  const t = document.createElement('div');
  t.className = 'toast' + (ok ? '' : ' warn');
  t.innerHTML = `<span class="toast-icon" aria-hidden="true">${ok ? '✓' : '!'}</span>
    <div class="toast-body"><div class="toast-title"></div><div class="toast-text"></div>
      <button class="toast-view">View answer</button></div>
    <button class="toast-close" aria-label="Dismiss">×</button>`;
  t.querySelector('.toast-title').textContent = title;
  t.querySelector('.toast-text').textContent = body;
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  t.querySelector('.toast-view').addEventListener('click', () => { close(); onView(); });
  t.querySelector('.toast-close').addEventListener('click', close);
  toastRegion().appendChild(t);
  setTimeout(close, 12000);
}

window.notifyAnswerReady = function notifyAnswerReady({ sessionId, question, ok }) {
  if (lookingAt(sessionId)) return;
  const title = ok ? 'Answer ready' : "Couldn't answer that";
  const body = question.length > 160 ? question.slice(0, 160) + '…' : question;
  if (document.hidden) {
    setBadge(unseen + 1);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`Lens MLOps · ${title}`, { body, tag: 'lens-mlops-' + sessionId });
        n.onclick = () => { n.close(); openAnswer(sessionId); };
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  }
  showToast({ title, body, ok, onView: () => openAnswer(sessionId) });
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.getElementById('tab-assistant').classList.contains('on')) setBadge(0);
});
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.tab === 'assistant') setBadge(0);
}));

window.offerNotifications = function offerNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  if (readNotifyPref('lensmlops.notifyAsked') || document.getElementById('notifyBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'notifyBanner';
  bar.className = 'notify-banner';
  bar.innerHTML = `<span>🔔 Get a notification when an answer is ready, even if you switch tabs?</span>
    <button class="notify-yes">Turn on</button><button class="notify-no">No thanks</button>`;
  const done = () => { writeNotifyPref('lensmlops.notifyAsked', '1'); bar.remove(); };
  // The browser's prompt can be quiet (an address-bar icon) or never appear, so its promise may
  // not settle: say what is happening at once, report the outcome, and never leave the banner stuck.
  const finish = (text, ok) => {
    writeNotifyPref('lensmlops.notifyAsked', '1');
    bar.classList.toggle('notify-ok', ok);
    bar.innerHTML = `<span>${ok ? '✓' : '🔔'} ${text}</span>`;
    setTimeout(() => bar.remove(), 4000);
  };
  const MESSAGES = {
    granted: ['Notifications are on. You\'ll get one when an answer is ready.', true],
    denied: ['Notifications are blocked for this site. To turn them on, use the lock icon next to the address.', false],
    default: ['Notifications are still off. You can allow them later with the lock icon next to the address.', false],
  };
  bar.querySelector('.notify-yes').addEventListener('click', () => {
    bar.querySelectorAll('button').forEach(b => { b.disabled = true; });
    bar.querySelector('span').textContent = '🔔 Choose "Allow" in your browser\'s prompt (it may appear as an icon next to the address).';
    let settled = false;
    const report = (perm) => { if (settled) return; settled = true; finish(...(MESSAGES[perm] || MESSAGES.default)); };
    const timer = setTimeout(() => report(Notification.permission), 15000);
    try {
      const p = Notification.requestPermission((perm) => { clearTimeout(timer); report(perm); });   // older Safari: callback only
      if (p && typeof p.then === 'function') p.then((perm) => { clearTimeout(timer); report(perm); }, () => { clearTimeout(timer); report('default'); });
    } catch { clearTimeout(timer); report('default'); }
  });
  bar.querySelector('.notify-no').addEventListener('click', done);
  document.querySelector('#tab-assistant .chat').insertBefore(bar, document.getElementById('chatMsgs'));
};
