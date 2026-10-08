// ---------------------------------------------------------------- voice input
// The mic button dictates a question into the composer with the browser's own
// speech recognition (Chrome and Edge; hidden where it isn't available). The
// words appear as they are recognised and the user reviews them before sending.
// Speech is handled by the browser; nothing is recorded or stored by the app.

(function setupVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById('micBtn');
  if (!Recognition || !btn) return;
  btn.hidden = false;

  let rec = null;
  let base = '';

  const stop = () => { if (rec) rec.stop(); };
  const setListening = (on) => {
    btn.classList.toggle('listening', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Stop listening' : 'Ask by voice';
    inputEl.placeholder = on ? 'Listening… speak your question' : 'Ask Lens';
  };

  btn.addEventListener('click', () => {
    if (rec) { stop(); return; }
    rec = new Recognition();
    rec.lang = navigator.language || 'en-US';   // e.g. en-IN, hi-IN: the question can be asked in the user's language
    rec.interimResults = true;
    rec.continuous = false;
    base = inputEl.value.trim() ? inputEl.value.trim() + ' ' : '';
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      inputEl.value = base + text;
      autosize();
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        alert('Microphone access is blocked. Allow it for this site in the browser to ask by voice.');
      }
    };
    rec.onend = () => { rec = null; setListening(false); inputEl.focus(); };
    setListening(true);
    try { rec.start(); } catch { rec = null; setListening(false); }
  });

  // Sending (or switching chats) stops dictation.
  sendBtn.addEventListener('click', stop);
  document.getElementById('newSessionBtn').addEventListener('click', stop);
})();
