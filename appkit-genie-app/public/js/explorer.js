// ---------------------------------------------------------------- Explorer
// The "why" behind the Command Center. Filters (business unit, site, asset type, model type,
// criticality, owner team, health and a day range) slice one governed view
// (gold.qry_explorer_base) with the same formulas as the Command Center, so with no filters
// every figure reconciles to it. Layer 1 is a dimension × measure slicer (click a bar to drill
// into it), then the diagnostic panels, then the model records behind the numbers. Every panel
// can hand its question, scoped to the current filters, to Lens. Uses the helpers in home.js.

(function setupExplorer() {
  const FILTERS = [
    ['business_unit', 'Business unit', 'All business units'],
    ['site', 'Site', 'All sites'],
    ['asset', 'Asset type', 'All asset types'],
    ['model_type', 'Model type', 'All model types'],
    ['criticality', 'Criticality', 'All levels'],
    ['team', 'Owner team', 'All teams'],
    ['health', 'Health', 'All models'],
  ];
  const DATE_LABELS = { dayFrom: 'Day from', dayTo: 'Day to' };
  const DIM_LABEL = Object.fromEntries(FILTERS.map(([k, l]) => [k, l]));
  const ms = v => (num(v) === null ? '—' : `${num(v).toFixed(0)} ms`);
  const MEASURES = {
    models: { label: 'Models', fmt: v => count(v), rate: false },
    attention_share: { label: 'Share needing attention', fmt: v => pct(v, 0), rate: true, good: false },
    avg_confidence: { label: 'Average confidence', fmt: v => pct(v, 1), rate: true, good: true },
    low_confidence_share: { label: 'Low-confidence predictions', fmt: v => pct(v, 1), rate: true, good: false },
    avg_drift: { label: 'Average drift', fmt: v => dec(v, 3), rate: true, good: false },
    avg_error_pct: { label: 'Error (% of actual)', fmt: v => pct(v, 1), rate: true, good: false },
    verified_share: { label: 'Verified against actuals', fmt: v => pct(v, 0), rate: true, good: true },
    alerts: { label: 'Alerts', fmt: v => count(v), rate: false },
    false_positive_rate: { label: 'False alarm rate', fmt: v => pct(v, 0), rate: true, good: false },
    cost_savings_usd: { label: 'Estimated savings', fmt: v => money(v), rate: false },
    downtime_avoided_hours: { label: 'Downtime avoided (hours)', fmt: v => count(v), rate: false },
    avg_latency_ms: { label: 'Scoring latency', fmt: ms, rate: true, good: false },
  };
  const PAGE = 12;

  const state = { filters: {}, dim: 'business_unit', measure: 'attention_share', view: 'bars', data: null, options: null,
    search: '', sort: 'attention', page: 0, seq: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem('lensmlops.explorer') || '{}');
    if (saved && typeof saved === 'object') Object.assign(state, {
      filters: saved.filters || {}, dim: DIM_LABEL[saved.dim] ? saved.dim : state.dim, measure: MEASURES[saved.measure] ? saved.measure : state.measure });
  } catch { /* ignore */ }
  const remember = () => { try { localStorage.setItem('lensmlops.explorer', JSON.stringify({ filters: state.filters, dim: state.dim, measure: state.measure })); } catch { /* ignore */ } };

  /** "for Refining, Houston 1, from 2026-10-06": the current filters in words, for questions and notes. */
  function scopeText() {
    const parts = FILTERS.filter(([k]) => state.filters[k]).map(([k]) => (k === 'health' ? `${state.filters[k].toLowerCase()} models` : k === 'criticality' ? `${state.filters[k]}-criticality models` : state.filters[k]));
    const f = state.filters;
    if (f.dayFrom || f.dayTo) parts.push(`days ${f.dayFrom ? 'from ' + f.dayFrom : ''}${f.dayTo ? ' to ' + f.dayTo : ''}`.trim());
    return parts.join(', ');
  }
  const scoped = (q) => { const sc = scopeText(); return sc ? `${q.replace(/\?$/, '')} (for ${sc})?` : q; };
  const ask = (q, mode = 'agent') => ({ q: scoped(q), mode });

  /**
   * "View" on any chart item: the models behind it, in the same window as the Command Center.
   * `seg` is the item's own filter (e.g. { site: 'Houston 1' }) or a health flag; the current
   * filters still apply.
   */
  const xpView = (seg, title, label = 'View') =>
    `<button class="view-btn sm" data-xpview="${hEsc(JSON.stringify(seg))}" data-title="${hEsc(title)}">${hEsc(label)}</button>`;
  document.getElementById('tab-explorer').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-xpview][role="button"]')) { e.preventDefault(); e.target.click(); }
  });
  const FLAG_RULE = { attention: 'drifting or low-confidence', drifting: 'drifting', low_confidence: 'low-confidence', with_alerts: 'raised alerts', healthy: 'healthy' };
  document.getElementById('tab-explorer').addEventListener('click', (e) => {
    const b = e.target.closest('[data-xpview]');
    if (!b || !window.showModelList) return;
    e.stopPropagation();
    const seg = JSON.parse(b.dataset.xpview);
    const merged = { ...state.filters, ...seg };
    delete merged.dayFrom; delete merged.dayTo;
    const qs = Object.entries(merged).filter(([, v]) => v).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const words = [
      ...FILTERS.filter(([k]) => merged[k]).map(([k, l]) => `${l}: ${merged[k]}`),
      merged.flag ? `models that are ${FLAG_RULE[merged.flag] || merged.flag}` : '',
    ].filter(Boolean);
    window.showModelList({
      url: '/api/explorer/models' + (qs ? '?' + qs : ''), title: b.dataset.title,
      rule: (words.length ? words.join(' · ') : 'All models') + '. Health and value cover the whole monitoring window.',
      file: 'lens-mlops-explorer-' + (Object.values(seg).join('-').replace(/\W+/g, '-').toLowerCase() || 'models'),
    });
  });

  // ---- filters
  function buildSelects() {
    const o = state.options?.dims || {};
    document.getElementById('xpSelects').innerHTML = FILTERS.map(([k, label, all]) => `
      <div class="field"><label for="xpf-${k}">${hEsc(label)}</label>
        <select id="xpf-${k}" data-f="${k}"><option value="">${hEsc(all)}</option>
          ${(o[k] || []).map(v => `<option value="${hEsc(v)}"${state.filters[k] === v ? ' selected' : ''}>${hEsc(v)}</option>`).join('')}
        </select></div>`).join('');
    const d = state.options?.dates || {};
    const setRange = (id, key) => { const el = document.getElementById(id); if (!el) return; if (d.dayMin) el.min = d.dayMin; if (d.dayMax) el.max = d.dayMax; el.value = state.filters[key] || ''; };
    setRange('xpDayFrom', 'dayFrom');
    setRange('xpDayTo', 'dayTo');
  }
  function setFilter(k, v) {
    if (v) state.filters[k] = v; else delete state.filters[k];
    state.page = 0;
    remember();
    buildSelects();
    load();
  }
  document.getElementById('tab-explorer').addEventListener('change', (e) => {
    const el = e.target.closest('[data-f]');
    if (el && (el.tagName === 'SELECT' || el.type === 'date')) setFilter(el.dataset.f, el.value);
  });
  document.getElementById('xpReset').addEventListener('click', () => { state.filters = {}; state.page = 0; state.search = ''; remember(); buildSelects(); load(); });
  document.getElementById('xpExport').addEventListener('click', exportCsv);

  function renderChips() {
    const chips = [
      ...FILTERS.filter(([k]) => state.filters[k]).map(([k, l]) => [k, `${l}: ${state.filters[k]}`]),
      ...Object.keys(DATE_LABELS).filter(k => state.filters[k]).map(k => [k, `${DATE_LABELS[k]}: ${state.filters[k]}`]),
    ];
    document.getElementById('xpChips').innerHTML = chips.length
      ? chips.map(([k, t]) => `<button class="xp-chip" data-clear="${k}" title="Remove this filter">${hEsc(t)} <span aria-hidden="true">×</span></button>`).join('')
        + `<button class="ask-link" data-ask="${hEsc(scoped('How do these models differ from the rest of the fleet on health, accuracy, alerts and value, and what should we do?'))}" data-mode="agent">${icon('spark', 'ico-xs')}Ask Lens about this view</button>`
      : '<span class="muted">No filters: showing the whole fleet. Pick a filter, or click any bar below to drill in.</span>';
    document.querySelectorAll('#xpChips [data-clear]').forEach(b => b.addEventListener('click', () => setFilter(b.dataset.clear, '')));
  }

  // ---- load
  async function load() {
    const my = ++state.seq;
    renderChips();
    document.getElementById('tab-explorer').classList.add('xp-loading');
    const qs = new URLSearchParams(Object.entries(state.filters).filter(([, v]) => v)).toString();
    try {
      const r = await fetch('/api/explorer/data' + (qs ? '?' + qs : ''));
      const d = await r.json();
      if (my !== state.seq) return;
      if (!r.ok) throw new Error(d.error || r.statusText);
      state.data = d;
      render();
    } catch (err) {
      if (my !== state.seq) return;
      console.error('Explorer failed to load', err);
      document.getElementById('xpMatch').textContent = 'Could not load. Please try again.';
      if (/Unknown /.test(String(err.message))) { state.filters = {}; remember(); buildSelects(); }
    } finally {
      if (my === state.seq) document.getElementById('tab-explorer').classList.remove('xp-loading');
    }
  }

  function render() {
    const d = state.data;
    const t = d.totals || {};
    const f = d.fleet || {};
    const filtered = Object.keys(d.applied || {}).length > 0;
    document.getElementById('xpMatch').innerHTML = `${count(t.models)} of ${count(f.models)} models · ${count(t.models_needing_attention)} need attention · ${money(t.cost_savings_usd)} estimated savings` +
      (filtered && num(f.cost_savings_usd) ? ` (${pct(num(t.cost_savings_usd) / num(f.cost_savings_usd), 0)} of the fleet's)` : '');
    const steps = [renderKpis, renderSlicer, renderHeat, renderHealth, renderAccuracy, renderTrend, renderValue, renderModelsTable];
    steps.forEach(fn => { try { fn(d); } catch (err) { console.error('Explorer panel failed', fn.name, err); } });
  }

  // ---- filtered headline measures, compared with the whole fleet
  function renderKpis(d) {
    const t = d.totals || {};
    const f = d.fleet || {};
    const filtered = Object.keys(d.applied || {}).length > 0;
    const delta = (key, good, fmt = 'pts') => {
      if (!filtered || num(t[key]) === null || num(f[key]) === null) return '';
      const diff = num(t[key]) - num(f[key]);
      const shown = fmt === 'pts' ? `${diff >= 0 ? '+' : '−'}${Math.abs(diff * 100).toFixed(1)} pts` : fmt === 'ms' ? `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(0)} ms` : `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(3)}`;
      const better = good ? diff > 0 : diff < 0;
      return `<span class="xk-d ${Math.abs(diff) < 1e-9 ? '' : better ? 'up' : 'down'}">${shown} vs fleet</span>`;
    };
    const share = (key) => (filtered && num(f[key]) ? `<span class="xk-d">${pct(num(t[key]) / num(f[key]), 1)} of fleet</span>` : '');
    const tiles = [
      ['Models', count(t.models), share('models')],
      ['Need attention', count(t.models_needing_attention), filtered ? delta('attention_share', false) : `<span class="xk-d">${pct(t.attention_share, 0)} of models</span>`],
      ['Average confidence', pct(t.avg_confidence, 1), delta('avg_confidence', true)],
      ['Low-confidence predictions', pct(t.low_confidence_share, 1), delta('low_confidence_share', false)],
      ['Average drift', dec(t.avg_drift, 3), delta('avg_drift', false, 'abs')],
      ['Error (% of actual)', pct(t.avg_error_pct, 1), delta('avg_error_pct', false)],
      ['Verified against actuals', pct(t.verified_share, 0), delta('verified_share', true)],
      ['Alerts', count(t.alerts), share('alerts')],
      ['False alarm rate', pct(t.false_positive_rate, 0), delta('false_positive_rate', false)],
      ['Estimated savings', money(t.cost_savings_usd), share('cost_savings_usd')],
      ['Downtime avoided', `${count(t.downtime_avoided_hours)} h`, share('downtime_avoided_hours')],
      ['Scoring latency', ms(t.avg_latency_ms), delta('avg_latency_ms', false, 'ms')],
    ];
    document.getElementById('xpKpis').innerHTML = tiles.map(([l, v, sub]) => `<div class="xk"><div class="xk-l">${l}</div><div class="xk-v">${v}</div>${sub || ''}</div>`).join('');
  }

  // ---- Layer 1: dimension × measure slicer
  function renderSlicer(d) {
    const el = document.getElementById('xpSlicer');
    const rows = (d.by[state.dim] || []).slice();
    const m = MEASURES[state.measure];
    const pv = (d.fleet || {})[state.measure];
    rows.sort((a, b) => (state.dim === 'criticality' ? 0 : num(b[state.measure]) - num(a[state.measure])));
    const max = Math.max(...rows.map(r => num(r[state.measure]) || 0), m.rate && num(pv) ? num(pv) : 0, 1e-9);
    const drillable = !state.filters[state.dim];
    const toneOf = (v) => {
      if (!m.rate || m.good === undefined || num(pv) === null) return 'brand';
      const better = m.good ? v > num(pv) * 1.05 : v < num(pv) * 0.95;
      const worse = m.good ? v < num(pv) * 0.95 : v > num(pv) * 1.05;
      return better ? 'good' : worse ? 'bad' : 'brand';
    };
    const bars = rows.map(r => {
      const v = num(r[state.measure]) || 0;
      return `<button class="xs-row${drillable ? '' : ' static'}" ${drillable ? `data-drill="${hEsc(r.k)}" title="Filter to ${hEsc(r.k)}"` : ''}>
        <div class="xs-top"><span class="xs-name">${hEsc(r.k)}</span>
          <span class="xs-meta">${count(r.models)} models · ${count(r.models_needing_attention)} need attention · ${pct(r.avg_confidence, 0)} confidence · ${money(r.cost_savings_usd)}</span>
          <b class="xs-val">${m.fmt(r[state.measure])}</b></div>
        <div class="hbar-track">${m.rate && num(pv) !== null ? `<span class="hbar-marker" style="left:${Math.min(100, (num(pv) / max) * 100).toFixed(1)}%" title="Fleet: ${m.fmt(pv)}"></span>` : ''}<span class="hbar-fill t-${toneOf(v)}" style="width:${Math.max(0.5, (v / max) * 100).toFixed(1)}%"></span></div>
      </button>`;
    }).join('');
    const table = `<div class="table-scroll flat"><table class="nice"><thead><tr><th>${hEsc(DIM_LABEL[state.dim])}</th><th>Models</th><th>Need attention</th><th>Confidence</th><th>Low-conf.</th><th>Drift</th><th>Error</th><th>Alerts</th><th>False alarms</th><th>Savings</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${hEsc(r.k)}</td><td>${count(r.models)}</td><td>${count(r.models_needing_attention)}</td><td>${pct(r.avg_confidence, 1)}</td><td>${pct(r.low_confidence_share, 1)}</td>
        <td>${dec(r.avg_drift, 3)}</td><td>${pct(r.avg_error_pct, 1)}</td><td>${count(r.alerts)}</td><td>${pct(r.false_positive_rate, 0)}</td><td>${money(r.cost_savings_usd)}</td>
        <td>${xpView({ [state.dim]: r.k }, `${r.k}: models`)}</td></tr>`).join('')}</tbody></table></div>`;
    const best = rows.length ? rows.reduce((a, r) => (num(r[state.measure]) > num(a[state.measure]) ? r : a)) : null;
    const worst = rows.length ? rows.reduce((a, r) => (num(r[state.measure]) < num(a[state.measure]) ? r : a)) : null;
    el.innerHTML = `<div class="panel-head"><div><div class="xs-kicker">Layer 1 · dimension &amp; measure</div><h3>Analytical exploration workspace</h3>
        <div class="panel-sub">${best && worst && rows.length > 1 ? `${hEsc(m.label)}: highest <b>${hEsc(best.k)}</b> (${m.fmt(best[state.measure])}), lowest <b>${hEsc(worst.k)}</b> (${m.fmt(worst[state.measure])})${m.rate && num(pv) !== null ? ` · fleet ${m.fmt(pv)} (marker)` : ''}.` : ''}</div></div>
      <div class="xs-ctl">
        <label>Dimension <select id="xsDim">${FILTERS.map(([k]) => `<option value="${k}"${k === state.dim ? ' selected' : ''}>${hEsc(DIM_LABEL[k])}</option>`).join('')}</select></label>
        <label>Measure <select id="xsMeasure">${Object.entries(MEASURES).map(([k, v]) => `<option value="${k}"${k === state.measure ? ' selected' : ''}>${hEsc(v.label)}</option>`).join('')}</select></label>
        <div class="seg-ctl xs-view"><button data-v="bars" class="${state.view === 'bars' ? 'on' : ''}" title="Bars">Bars</button><button data-v="table" class="${state.view === 'table' ? 'on' : ''}" title="Table">Table</button></div>
        ${askBtn(scoped(`Compare ${m.label.toLowerCase()} by ${DIM_LABEL[state.dim].toLowerCase()} and explain what drives the differences`), 'agent')}
      </div></div>
      <div class="panel-body">${rows.length ? (state.view === 'table' ? table : `<div class="xs-list">${bars}</div>`) : '<div class="empty-note">No models match these filters.</div>'}
      ${drillable && rows.length > 1 && state.view === 'bars' ? '<div class="panel-note">Click a bar to filter everything on this page to it.</div>' : ''}</div>`;
    el.querySelector('#xsDim').addEventListener('change', e => { state.dim = e.target.value; remember(); renderSlicer(state.data); });
    el.querySelector('#xsMeasure').addEventListener('change', e => { state.measure = e.target.value; remember(); renderSlicer(state.data); });
    el.querySelectorAll('.xs-view button').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.v; renderSlicer(state.data); }));
    el.querySelectorAll('[data-drill]').forEach(b => b.addEventListener('click', () => setFilter(state.dim, b.dataset.drill)));
  }

  // ---- why: business unit × asset type
  function renderHeat(d) {
    const cells = d.grid || [];
    const units = [...new Set(cells.map(c => c.business_unit))].sort();
    const assets = [...new Set(cells.map(c => c.asset_type))].sort();
    const get = (u, a) => cells.find(c => c.business_unit === u && c.asset_type === a);
    const toneOf = c => (!c ? 'neutral' : num(c.models_needing_attention) === 0 ? 'good' : num(c.attention_share) < 0.34 ? 'warn' : 'bad');
    const body = units.length ? `<div class="table-scroll flat"><div class="heat" style="grid-template-columns:150px repeat(${assets.length},minmax(70px,1fr))">
      <div></div>${assets.map(a => `<div class="heat-h">${hEsc(a)}</div>`).join('')}
      ${units.map(u => `<div class="heat-r">${hEsc(u)}</div>${assets.map(a => {
        const c = get(u, a);
        if (!c) return '<div class="heat-c t-neutral"><small>no models</small></div>';
        return `<div class="heat-c t-${toneOf(c)}" role="button" tabindex="0" data-xpview="${hEsc(JSON.stringify({ business_unit: u, asset: a }))}" data-title="${hEsc(`${u} · ${a}: models`)}"
          title="${hEsc(`${u} · ${a}: ${count(c.models_needing_attention)} of ${count(c.models)} models need attention. Click to see them.`)}">${count(c.models_needing_attention)}/${count(c.models)}<small>${num(c.cost_savings_usd) ? money(c.cost_savings_usd) + ' saved' : 'need attention'}</small></div>`;
      }).join('')}`).join('')}</div></div>
      <div class="heat-legend"><span class="t-good">None need attention</span><span class="t-warn">Under a third</span><span class="t-bad">A third or more</span><span class="muted">· cells show models needing attention / models · click a cell to see them</span></div>` : '<div class="empty-note">No models match these filters.</div>';
    panel('xpHeat', 'Models needing attention by business unit and asset type', 'Drifting or low-confidence models on the latest day, of each cell\'s models.',
      ask('Which business units and asset types have the most models needing attention, and what is wrong with them?'), body);
  }

  // ---- why: health split and criticality
  function renderHealth(d) {
    const rows = d.by.criticality || [];
    const health = d.by.health || [];
    const total = health.reduce((a, r) => a + num(r.models), 0);
    const split = health.length ? `<div class="hp-legend" style="margin-bottom:10px">${health.map(r => `<span>${healthTag(r.k)} ${count(r.models)} <span class="muted">(${pct(num(r.models) / total, 0)})</span> ${xpView({ health: r.k }, `${r.k} models`)}</span>`).join(' ')}</div>` : '';
    const body = split + `<div class="table-scroll flat"><table class="mini"><thead><tr><th>Criticality</th><th>Models</th><th>Need attention</th><th>Confidence</th><th>Savings</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${hEsc(r.k)}</td><td>${count(r.models)}</td><td>${num(r.models_needing_attention) ? `<b>${count(r.models_needing_attention)}</b>` : '0'}</td>
        <td>${pct(r.avg_confidence, 1)}</td><td>${money(r.cost_savings_usd)}</td>
        <td>${num(r.models_needing_attention) ? xpView({ criticality: r.k, flag: 'attention' }, `${r.k}-criticality models needing attention`) : xpView({ criticality: r.k }, `${r.k}-criticality models`)}</td></tr>`).join('')}</tbody></table></div>`;
    panel('xpHealth', 'Health and criticality', 'How many models are healthy, and where the business-critical ones stand.',
      ask('Which business-critical models need attention, and how do they compare with the rest?'), rows.length ? body : '<div class="empty-note">No data.</div>');
  }

  // ---- why: accuracy by asset type
  function renderAccuracy(d) {
    const rows = (d.by.asset || []).slice().sort((a, b) => num(b.avg_error_pct) - num(a.avg_error_pct));
    const fleet = num((d.totals || {}).avg_error_pct);
    const max = Math.max(...rows.map(r => num(r.avg_error_pct) || 0), fleet || 0, 0.0001);
    panel('xpAccuracy', 'Accuracy by asset type', `Error as a share of actual values, averaged over each type's models${fleet !== null ? ` (this view ${pct(fleet, 1)}, marker)` : ''}.`,
      ask('Which asset types and models are least accurate against actual values?'),
      rows.map(r => bar(hEsc(r.k), num(r.avg_error_pct), max * 1.05, pct(r.avg_error_pct, 1), fleet !== null && num(r.avg_error_pct) > fleet * 1.5 ? 'bad' : 'brand',
        `${count(r.models)} models · ${pct(r.verified_share, 0)} verified ${xpView({ asset: r.k }, `${r.k} models`)}`, fleet)).join('') || '<div class="empty-note">No data.</div>');
  }

  // ---- why: day by day
  function renderTrend(d) {
    const rows = d.trend || [];
    const maxDrift = Math.max(...rows.map(r => num(r.avg_drift) || 0), 0.0001);
    const body = `<div class="table-scroll flat"><table class="mini"><thead><tr><th>Day</th><th>Confidence</th><th>Low-conf.</th><th>Average drift</th><th>Alerts</th><th>Confirmed</th><th>Savings</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${when(r.day)}</td><td>${pct(r.avg_confidence, 1)}</td><td>${pct(r.low_confidence_share, 1)}</td>
        <td><span class="pareto"><span style="width:${(100 * num(r.avg_drift) / maxDrift).toFixed(0)}%"></span></span>${dec(r.avg_drift, 3)}</td>
        <td>${count(r.alerts)}</td><td>${count(r.confirmed_incidents)}</td><td>${money(r.cost_savings_usd)}</td></tr>`).join('')}</tbody></table></div>
      <div class="panel-note">Three days of data: this shows how the window unfolded, not a trend to project forward.</div>`;
    panel('xpTrend', 'Day by day', 'Confidence, drift, alerts and value for each day in view.',
      ask('How did model confidence, drift and alerts change day by day, and which models drove the change?'), rows.length ? body : '<div class="empty-note">No data.</div>');
  }

  // ---- why: value by site
  function renderValue(d) {
    const rows = (d.by.site || []).slice().sort((a, b) => num(b.cost_savings_usd) - num(a.cost_savings_usd));
    const max = Math.max(...rows.map(r => num(r.cost_savings_usd) || 0), 1);
    panel('xpValue', 'Value by site', 'Estimated savings and downtime avoided where the models run.',
      ask('Which sites delivered the most value, and which incidents drove it?'),
      rows.map(r => bar(hEsc(r.k), num(r.cost_savings_usd), max, money(r.cost_savings_usd), num(r.cost_savings_usd) ? 'good' : 'brand',
        `${count(r.models)} models · ${num(r.alerts) ? `${count(r.confirmed_incidents)} of ${count(r.alerts)} alerts confirmed · ${count(r.downtime_avoided_hours)} h avoided` : 'no alerts'} ${xpView({ site: r.k }, `${r.k}: models`)}`)).join('') || '<div class="empty-note">No data.</div>');
  }

  // ---- Layer 2: model records
  const SORTS = {
    attention: ['Needs attention first', r => (r.health_status === 'Drifting' ? 0 : r.health_status === 'Low confidence' ? 1 : 2) * 1e12 - num(r.cost_savings_usd)],
    savings: ['Savings', r => -num(r.cost_savings_usd)],
    drift: ['Drift', r => -num(r.avg_drift)],
    confidence: ['Lowest confidence', r => num(r.avg_confidence)],
    error: ['Error', r => -num(r.error_pct)],
    alerts: ['Alerts', r => -num(r.alerts)],
  };
  function modelRows() {
    const q = state.search.trim().toLowerCase();
    const rows = (state.data?.models || []).filter(r => !q || [r.model_id, r.model_name, r.business_unit, r.site_name, r.asset_type, r.owner_team, r.health_status]
      .some(v => String(v || '').toLowerCase().includes(q)));
    const key = SORTS[state.sort][1];
    return rows.sort((a, b) => key(a) - key(b));
  }
  function renderModelsTable(d) {
    const el = document.getElementById('xpModels');
    const all = modelRows();
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const rows = all.slice(state.page * PAGE, state.page * PAGE + PAGE);
    const searchHad = document.activeElement && document.activeElement.id === 'xpSearch';
    el.innerHTML = `<div class="panel-head"><div><div class="xs-kicker">Layer 2 · model records</div><h3>Models behind the numbers</h3>
        <div class="panel-sub">${all.length < (d.models || []).length ? `${count(all.length)} of ` : ''}the ${count((d.models || []).length)} models in this view; figures follow the day range</div></div>
      <div class="xs-ctl">
        <input type="search" id="xpSearch" placeholder="Search model, business unit, site, asset, team" value="${hEsc(state.search)}" aria-label="Search models">
        <label>Sort <select id="xpSort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}"${k === state.sort ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      </div></div>
      <div class="panel-body"><div class="table-scroll flat"><table class="nice xp-acc">
        <thead><tr><th>Model</th><th>Business unit · site</th><th>Asset · criticality</th><th>Health</th><th>Confidence</th><th>Drift</th><th>Error</th><th>Alerts</th><th>Savings</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${modelCell(r)}</td>
          <td>${hEsc(r.business_unit)} <span class="muted">· ${hEsc(r.site_name)}</span></td>
          <td>${hEsc(r.asset_type)} <span class="muted">· ${hEsc(r.criticality)}</span></td>
          <td>${healthTag(r.health_status)}</td>
          <td><span class="pill-bar"><span style="width:${(num(r.avg_confidence) * 100).toFixed(0)}%"></span></span>${pct(r.avg_confidence, 0)} <span class="muted">· ${pct(r.low_confidence_share, 0)} low</span></td>
          <td><span class="xp-tag ${r.health_status === 'Drifting' ? 'bad' : 'ok'}">${dec(r.avg_drift, 2)}</span></td>
          <td>${pct(r.error_pct, 1)}</td>
          <td>${num(r.alerts) ? `${count(r.confirmed_incidents)}/${count(r.alerts)}` : '<span class="muted">—</span>'}</td>
          <td>${num(r.cost_savings_usd) ? `<b>${money(r.cost_savings_usd)}</b>` : '<span class="muted">—</span>'}</td>
          <td><button class="ask-link" data-ask="${hEsc(`Tell me about ${r.model_name} (${r.model_id}): its health, drift, confidence, accuracy, alerts and value, and what we should do.`)}" data-mode="chat">${icon('spark', 'ico-xs')}Ask Lens</button></td></tr>`).join('')
          || '<tr><td colspan="10" class="empty-note">No models match.</td></tr>'}</tbody></table></div>
        <div class="xp-pager"><span>Showing ${all.length ? state.page * PAGE + 1 : 0} to ${Math.min(all.length, (state.page + 1) * PAGE)} of ${count(all.length)}</span>
          <span><button class="btn ghost" id="xpPrev" ${state.page ? '' : 'disabled'} aria-label="Previous page">‹</button> Page ${state.page + 1} of ${pages} <button class="btn ghost" id="xpNext" ${state.page < pages - 1 ? '' : 'disabled'} aria-label="Next page">›</button></span></div>
      </div>`;
    const s = el.querySelector('#xpSearch');
    s.addEventListener('input', () => { state.search = s.value; state.page = 0; renderModelsTable(state.data); });
    if (searchHad) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    el.querySelector('#xpSort').addEventListener('change', e => { state.sort = e.target.value; state.page = 0; renderModelsTable(state.data); });
    el.querySelector('#xpPrev').addEventListener('click', () => { state.page--; renderModelsTable(state.data); });
    el.querySelector('#xpNext').addEventListener('click', () => { state.page++; renderModelsTable(state.data); });
  }

  function exportCsv() {
    const rows = modelRows();
    if (!rows.length) return;
    const cols = ['model_id', 'model_name', 'business_unit', 'site_name', 'asset_type', 'model_type', 'criticality', 'owner_team', 'health_status',
      'predictions', 'avg_confidence', 'low_confidence_share', 'avg_drift', 'error_pct', 'avg_latency_ms', 'alerts', 'confirmed_incidents',
      'false_positives', 'downtime_avoided_hours', 'cost_savings_usd'];
    const sc = scopeText();
    downloadCsv(`lens-mlops-explorer-models${state.filters.dayFrom || state.filters.dayTo ? '-' + (state.filters.dayFrom || '') + '-' + (state.filters.dayTo || '') : ''}`,
      `# Lens MLOps Explorer${sc ? `, filters: ${sc}` : ''}`, cols, rows);
  }

  // ---- first open
  let started = false;
  window.loadExplorer = async function loadExplorer() {
    if (started) return;
    started = true;
    document.querySelectorAll('#tab-explorer .panel').forEach(p => { if (!p.innerHTML.trim()) p.innerHTML = '<div class="skel skel-h"></div><div class="skel"></div><div class="skel"></div><div class="skel short"></div>'; });
    try {
      const r = await fetch('/api/explorer/options');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      state.options = await r.json();
      for (const k of Object.keys(state.filters)) {
        if (DATE_LABELS[k]) continue;
        if (!(state.options.dims[k] || []).includes(state.filters[k])) delete state.filters[k];
      }
    } catch (err) {
      console.error('Explorer options failed', err);
      document.getElementById('xpMatch').textContent = 'The Explorer view is not available yet. Run the deploy\'s views step.';
      started = false;
      return;
    }
    buildSelects();
    load();
  };
  /** Open the Explorer filtered to one value (used by the Command Center). */
  window.exploreBy = (k, v) => { state.filters = v ? { [k]: v } : {}; remember(); if (started) { buildSelects(); load(); } window.showTab && window.showTab('explorer'); };
})();
