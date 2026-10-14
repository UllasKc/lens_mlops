// ---------------------------------------------------------------- Databricks cost (Observability area 8)
// What this app's workspace has cost since its first day, by service, from the billing system
// tables at list price (GET /api/cost). It is the whole workspace's spend: where other projects
// share the workspace, their usage is included.

let costLoaded = false;
let costChart = null;

/** Friendly names and colours for billing_origin_product. */
const COST_SERVICES = {
  SQL: ['SQL warehouse', '#2563EB', 'Command Center and Explorer queries, Genie SQL and the deploy'],
  APPS: ['Databricks App', '#0E9384', 'The Lens MLOps web app’s compute (and any other app in the workspace)'],
  LAKEBASE: ['Lakebase (Postgres)', '#9333EA', 'Chat history, usage log and answer cache'],
  DATABASE: ['Lakebase (Postgres)', '#9333EA', 'Chat history, usage log and answer cache'],
  GENIE: ['Genie', '#F59E0B', 'Natural-language questions'],
  MODEL_SERVING: ['Model serving', '#DC2626', 'Guardrails, judge, router and follow-ups'],
  AI_GATEWAY: ['AI Gateway', '#E11D48', 'Model calls through the gateway'],
  FOUNDATION_MODEL_TRAINING: ['Model training', '#BE123C', ''],
  PREDICTIVE_OPTIMIZATION: ['Predictive optimization', '#64748B', 'Automatic table maintenance'],
  INTERACTIVE: ['Notebooks (serverless)', '#0891B2', 'Interactive notebook compute'],
  JOBS: ['Jobs', '#4338CA', 'Scheduled and one-off jobs'],
  DLT: ['Pipelines', '#7C3AED', 'Declarative pipelines'],
  VECTOR_SEARCH: ['Vector search', '#DB2777', ''],
  DEFAULT_STORAGE: ['Storage', '#A3A3A3', 'Managed storage'],
  NETWORKING: ['Networking', '#94A3B8', 'Data transfer'],
};
const costService = (p) => COST_SERVICES[p] || [String(p || 'Other').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), '#CBD5E1', ''];

window.loadCost = async function loadCost(refresh = false) {
  const el = document.getElementById('costBody');
  if (costLoaded && !refresh) return;
  let d;
  try {
    d = await fetch('/api/cost' + (refresh ? '?refresh=1' : '')).then((r) => r.json());
  } catch {
    el.innerHTML = '<div class="card score-reason">Could not load the cost figures.</div>';
    return;
  }
  if (!d.available) { el.innerHTML = costUnavailable(d); return; }
  costLoaded = true;
  renderCost(el, d);
};

function costUnavailable(d) {
  const why = {
    access: 'The cost view (<code>gold.qry_platform_cost</code>) isn’t there yet. The deploy’s app step creates it, and the person deploying needs SELECT on <code>system.billing.usage</code> and <code>system.billing.list_prices</code>.',
  }[d.reason] || `The billing query failed: ${hEscC(d.message || 'unknown error')}`;
  return `<div class="card cost-empty"><b>Cost figures aren’t available.</b><p>${why}</p></div>`;
}

const hEscC = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderCost(el, d) {
  const cur = d.currency || 'USD';
  const fmt = (v, dp = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v || 0);
  const days = [...new Set(d.daily.map((r) => r.day))].sort();
  const total = d.daily.reduce((t, r) => t + r.cost, 0);
  const last = d.last_day || days[days.length - 1];
  const month = String(last || '').slice(0, 7);
  const monthCost = d.daily.filter((r) => String(r.day).startsWith(month)).reduce((t, r) => t + r.cost, 0);
  const weekStart = days[Math.max(0, days.length - 7)];
  const weekCost = d.daily.filter((r) => r.day >= weekStart).reduce((t, r) => t + r.cost, 0);
  const span = days.length ? Math.round((new Date(last) - new Date(d.first_day)) / 86400000) + 1 : 0;

  // By service, largest first; services under 0.5% are grouped as "Other" in the chart only.
  const byService = {};
  d.daily.forEach((r) => { byService[r.product] = (byService[r.product] || 0) + r.cost; });
  const services = Object.entries(byService).sort((a, b) => b[1] - a[1]);
  const top = services[0];
  const dateFmt = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const through = d.data_through ? new Date(d.data_through).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : dateFmt(last);

  el.innerHTML = `
    <section class="cost-hero">
      <div class="ch-main">
        <div class="ch-eyebrow">Total Databricks cost since day 1</div>
        <div class="ch-total">${fmt(total)}</div>
        <div class="ch-sub">${dateFmt(d.first_day)} to ${dateFmt(last)} · ${span} days · this workspace</div>
        <div class="ch-bar" role="img" aria-label="${hEscC(services.map(([p, v]) => `${costService(p)[0]} ${fmt(v)}`).join(', '))}">
          ${services.map(([p, v]) => `<span style="width:${(100 * v / (total || 1)).toFixed(2)}%;background:${costService(p)[1]}" title="${hEscC(costService(p)[0])}: ${fmt(v)}"></span>`).join('')}
        </div>
      </div>
      <div class="ch-tiles">
        ${[
          ['This month', fmt(monthCost), new Date(month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })],
          ['Last 7 days', fmt(weekCost), `${fmt(weekCost / Math.min(7, days.length || 1))} a day`],
          ['Average per day', fmt(total / (span || 1)), 'since day 1'],
          ['Biggest service', top ? costService(top[0])[0] : '—', top ? `${fmt(top[1])} · ${((100 * top[1]) / (total || 1)).toFixed(0)}% of the total` : ''],
        ].map(([l, v, s]) => `<div class="ch-tile"><div class="ch-l">${l}</div><div class="ch-v">${hEscC(v)}</div><div class="ch-s">${hEscC(s)}</div></div>`).join('')}
      </div>
    </section>

    <div class="grid cost-grid">
      <div class="card chart-card"><h3>Cost per day, by service</h3><div class="cv"><canvas id="costDailyChart"></canvas></div></div>
      <div class="card cost-services">
        <h3 class="cost-h">By service, since day 1</h3>
        ${services.map(([p, v]) => {
          const [name, colour, what] = costService(p);
          const share = (100 * v) / (total || 1);
          return `<div class="cs-row">
            <div class="cs-name"><i style="background:${colour}"></i><div><b>${hEscC(name)}</b>${what ? `<small>${hEscC(what)}</small>` : ''}</div></div>
            <div class="cs-val">${fmt(v)}<small>${share < 0.1 ? '<0.1' : share.toFixed(1)}%</small></div>
            <div class="cs-track"><span style="width:${Math.max(share, 0.5).toFixed(2)}%;background:${colour}"></span></div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card table-scroll" style="margin-top:14px">
      <h3 class="cost-h">The 12 most expensive line items (SKUs)</h3>
      <table><thead><tr><th>SKU</th><th>Service</th><th style="text-align:right">Quantity used</th><th style="text-align:right">Cost</th></tr></thead>
      <tbody>${d.skus.map((s) => `<tr><td class="mono">${hEscC(s.sku)}</td><td>${hEscC(costService(s.product)[0])}</td>
        <td style="text-align:right">${s.quantity.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${hEscC(String(s.unit || '').toLowerCase())}</td>
        <td style="text-align:right"><b>${fmt(s.cost)}</b></td></tr>`).join('')}</tbody></table>
    </div>

    <p class="cost-note">From <code>system.billing.usage</code> priced with <code>system.billing.list_prices</code> (the list price in force on each day), for this workspace only.
      It is the whole workspace's usage, so other projects that share the workspace are included.
      These are list prices before any discount or committed-use contract, so the invoice can be lower; on a Free Edition workspace nothing is charged.
      Billing data arrives a few hours late: figures run to ${hEscC(through)} (UTC).
      <button class="btn sm" id="costRefresh">Refresh</button></p>`;

  document.getElementById('costRefresh').addEventListener('click', () => { costLoaded = false; window.loadCost(true); });

  // Stacked bars per day, plus the running total on a second axis.
  const ctx = document.getElementById('costDailyChart');
  if (!ctx || !window.Chart) return;
  if (costChart) costChart.destroy();
  const label = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  let run = 0;
  const cumulative = days.map((day) => (run += d.daily.filter((r) => r.day === day).reduce((t, r) => t + r.cost, 0)));
  costChart = new Chart(ctx, {
    data: {
      labels: days.map(label),
      datasets: [
        ...services.map(([p]) => ({
          type: 'bar', label: costService(p)[0], backgroundColor: costService(p)[1], stack: 'cost', yAxisID: 'y',
          data: days.map((day) => (d.daily.find((r) => r.day === day && r.product === p) || {}).cost || 0),
        })),
        { type: 'line', label: 'Running total', data: cumulative, yAxisID: 'y2', borderColor: '#0F172A', borderWidth: 2, pointRadius: 0, tension: 0.25 },
      ],
    },
    options: {
      maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { filter: (i) => i.raw > 0.004, callbacks: { label: (i) => `${i.dataset.label}: ${fmt(i.raw)}` } },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, font: { size: 10 } } },
        y: { stacked: true, title: { display: true, text: 'Per day' }, ticks: { callback: (v) => fmt(v, 0) } },
        y2: { position: 'right', grid: { display: false }, title: { display: true, text: 'Running total' }, ticks: { callback: (v) => fmt(v, 0) } },
      },
    },
  });
}
