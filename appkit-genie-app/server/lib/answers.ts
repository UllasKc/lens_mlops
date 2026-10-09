/**
 * One answer shape for both modes, so the UI renders — and Lakebase stores —
 * the same thing whether Chat or Agent mode produced it. Text may contain
 * `[[chart:<id>]]` markers where Agent mode placed a visualization inline;
 * charts without a marker are shown after the text.
 */
export interface ChartSpec {
  id: string;
  title: string;
  sql?: string;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Array<string | null>>;
  truncated?: boolean;
}

export interface AgentStep {
  kind: 'reasoning' | 'sql' | 'viz';
  text: string;
  sql?: string;
}

export interface Answer {
  version: 2;
  mode: 'chat' | 'agent';
  text: string;
  charts: ChartSpec[];
  steps?: AgentStep[];
  suggestions?: string[];
  /** Set when the answer was served from the answer cache instead of Genie. */
  cache?: { generatedAt: string; source: 'live' | 'prewarm'; similarTo?: { question: string; similarity: number } };
  /** Guardrail outcome shown with the answer: blocked questions, and notes such as removed PII. */
  guard?: { blocked?: boolean; notices?: string[] };
  /** Set when the question was about the platform and was answered from the platform guide, not the data. */
  platform?: { method: 'ai' | 'guide'; sections: string[] };
  /** How the router sent it, and the question it answered (shown under the answer, with Go deeper / Ask the data). */
  route?: { destination: 'data' | 'platform'; intent: string; reason: string; escalated: boolean; method: string; asked: string };
}

/** Enough rows for any sensible chart or table; keeps Lakebase rows small. */
const MAX_ROWS = 500;

export function capRows(rows: Array<Array<string | null>>): { rows: Array<Array<string | null>>; truncated: boolean } {
  return rows.length > MAX_ROWS ? { rows: rows.slice(0, MAX_ROWS), truncated: true } : { rows, truncated: false };
}

const NUMERIC = /^(DOUBLE|FLOAT|DECIMAL|INT|INTEGER|BIGINT|LONG|SHORT|SMALLINT|TINYINT|BYTE)/i;

/** "cost_savings_usd, downtime_avoided_hours / business_unit" -> "cost savings usd vs downtime avoided hours by business unit" */
function titleFromColumns(columns: Array<{ name: string; type: string }>): string {
  const pretty = (n: string) => n.replace(/_/g, ' ');
  const measures = columns.filter((c) => NUMERIC.test(c.type) && !/(^|_)(id|key)$/i.test(c.name)).map((c) => pretty(c.name));
  const dims = columns.filter((c) => !NUMERIC.test(c.type)).map((c) => pretty(c.name));
  if (!measures.length) return dims.slice(0, 3).join(', ') || 'Query result';
  const m = measures.length > 2 ? `${measures.slice(0, 2).join(', ')} and more` : measures.join(' vs ');
  return dims.length ? `${m} by ${dims.slice(0, 2).join(' and ')}` : m;
}

// --- Chat mode ---------------------------------------------------------------

interface ChatAttachment {
  attachmentId?: string;
  query?: { title?: string; description?: string; query?: string };
  text?: { content?: string };
  suggestedQuestions?: string[];
}

interface StatementResponse {
  manifest?: { schema?: { columns?: Array<{ name: string; type_name: string }> } };
  result?: { data_array?: Array<Array<string | null>> };
}

/**
 * Genie cites its queries with links into the Genie space in this workspace,
 * e.g. `[[1](https://<workspace>/genie/rooms/…)]`. App users can't open them
 * (they have no Genie access) and they expose the workspace address, so they
 * are removed; the SQL behind each answer is shown in the app instead.
 */
export function stripCitations(text: string): string {
  return text
    .replace(/[ \t]*\\?\[\\?\[\d+\\?\]\([^)\s]*\)\\?\]/g, '') // [[1](url)], also with escaped brackets
    .replace(/[ \t]*\\?\[\\?\[\d+\\?\]\\?\]\([^)\s]*\)/g, '') // [[1]](url)
    .replace(/[ \t]*\\?\[\\?\[\d+\\?\]\\?\]?\([^)\s]*$/, '') // a citation cut off by truncation
    // Agent mode's newer marker, e.g. *[unrendered:citation[01f1…]]*, sometimes several in a row
    .replace(/[ \t]*[*_]?\\?\[unrendered:citation\\?\[[^\]\s]*\\?\]\\?\][*_]?/g, '')
    .replace(/[ \t]*[*_]?\\?\[unrendered:citation[^\n]*$/, '') // cut off by truncation
    .replace(/[ \t]+([.,;:])/g, '$1');
}

export function chatAnswer(
  attachments: ChatAttachment[],
  queryResults: Map<string, StatementResponse>,
): Answer {
  const text = attachments.find((a) => typeof a.text?.content === 'string')?.text?.content ?? '';
  const suggestions = attachments.flatMap((a) => a.suggestedQuestions ?? []);
  const charts: ChartSpec[] = [];
  for (const a of attachments) {
    if (!a.query || !a.attachmentId) continue;
    const data = queryResults.get(a.attachmentId);
    const columns = (data?.manifest?.schema?.columns ?? []).map((c) => ({ name: c.name, type: c.type_name }));
    if (!columns.length) continue;
    const { rows, truncated } = capRows(data?.result?.data_array ?? []);
    charts.push({
      id: a.attachmentId,
      // Genie rarely sets a title; its description is a sentence ("You want to see…"), so name it from the columns.
      title: a.query.title || titleFromColumns(columns),
      sql: a.query.query,
      columns,
      rows,
      truncated,
    });
  }
  return { version: 2, mode: 'chat', text: stripCitations(text), charts, suggestions };
}

/** Every result Genie's SQL returned for an answer (capped), for the faithfulness judge. Not stored. */
export interface Evidence {
  title: string;
  columns: string[];
  rows: Array<Array<string | null>>;
}

const EVIDENCE_ROWS = 60;

export function chatEvidence(attachments: ChatAttachment[], queryResults: Map<string, StatementResponse>): Evidence[] {
  return attachments
    .filter((a) => a.query && a.attachmentId && queryResults.has(a.attachmentId))
    .map((a) => {
      const data = queryResults.get(a.attachmentId!)!;
      return {
        title: a.query?.title || a.query?.description || 'Query',
        columns: (data.manifest?.schema?.columns ?? []).map((c) => c.name),
        rows: (data.result?.data_array ?? []).slice(0, EVIDENCE_ROWS),
      };
    });
}

export function agentEvidence(output: AgentOutputItem[]): Evidence[] {
  const titles = new Map<string, string>();
  const out: Evidence[] = [];
  for (const item of output) {
    if (item.type === 'function_call' && item.name === 'execute_sql' && item.call_id) {
      let args: { title?: string } = {};
      try { args = JSON.parse(item.arguments ?? '{}'); } catch { /* keep empty */ }
      titles.set(item.call_id, args.title ?? 'Query');
    } else if (item.type === 'function_call_output' && item.call_id && titles.has(item.call_id)) {
      const t = parseMarkdownTable(item.output ?? '');
      if (t) out.push({ title: titles.get(item.call_id)!, columns: t.columns, rows: t.rows.slice(0, EVIDENCE_ROWS) });
    }
  }
  return out;
}

/** One SQL statement Genie ran for an answer, for the Monitoring audit trail. */
export interface QueryRun {
  title: string;
  sql: string;
  rows: number | null;
}

export function chatQueries(
  attachments: ChatAttachment[],
  queryResults: Map<string, StatementResponse>,
): QueryRun[] {
  return attachments
    .filter((a) => a.query?.query)
    .map((a) => ({
      title: a.query?.title || a.query?.description || 'Query',
      sql: a.query?.query ?? '',
      rows: a.attachmentId ? queryResults.get(a.attachmentId)?.result?.data_array?.length ?? null : null,
    }));
}

// --- Agent mode --------------------------------------------------------------

interface AgentOutputItem {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  output?: string;
  content?: Array<{ type?: string; text?: string; metadata?: { viz?: { attachment_id?: string } } }>;
  metadata?: { viz?: { attachment_id?: string; query_attachment_id?: string } };
}

/** `execute_sql` returns its result as "**Title**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |". */
export function parseMarkdownTable(md: string): { columns: string[]; rows: string[][] } | null {
  const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 2) return null;
  // Cell values can contain escaped pipes ("a \| b"); splitting on them dropped whole rows.
  const cells = (l: string) => l.replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const columns = cells(lines[0]);
  const rows = lines.slice(2).map(cells).filter((r) => r.length === columns.length);
  return { columns, rows };
}

function inferType(values: Array<string | null>): string {
  const present = values.filter((v): v is string => v !== null && v !== '' && v !== 'null');
  if (present.length && present.every((v) => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v))) return 'DOUBLE';
  if (present.length && present.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v))) return 'DATE';
  return 'STRING';
}

/** Every `execute_sql` step with its SQL and the number of rows it returned. */
export function agentQueries(output: AgentOutputItem[]): QueryRun[] {
  const calls = new Map<string, QueryRun>();
  for (const item of output) {
    if (item.type === 'function_call' && item.name === 'execute_sql' && item.call_id) {
      let args: { title?: string; sql?: string } = {};
      try { args = JSON.parse(item.arguments ?? '{}'); } catch { /* keep empty */ }
      calls.set(item.call_id, { title: args.title ?? 'Query', sql: args.sql ?? '', rows: null });
    } else if (item.type === 'function_call_output' && item.call_id && calls.has(item.call_id)) {
      calls.get(item.call_id)!.rows = parseMarkdownTable(item.output ?? '')?.rows.length ?? null;
    }
  }
  return [...calls.values()];
}

/** Genie's own id for the answer (needed for its feedback API); items carry it in metadata. */
export function agentMessageId(output: Array<{ metadata?: { message_id?: string } }>): string | null {
  for (let i = output.length - 1; i >= 0; i--) {
    const id = output[i].metadata?.message_id;
    if (id) return id;
  }
  return null;
}

export function agentAnswer(output: AgentOutputItem[]): Answer {
  const steps: AgentStep[] = [];
  const sqlCalls = new Map<string, { title: string; sql: string }>();
  const sqlResults = new Map<string, { columns: string[]; rows: string[][] }>();
  const vizToQuery = new Map<string, { title: string; queryId: string }>();

  for (const item of output) {
    if (item.type === 'reasoning') {
      const t = (item.content ?? []).map((c) => c.text ?? '').join(' ').trim();
      if (t) steps.push({ kind: 'reasoning', text: t });
    } else if (item.type === 'function_call' && item.call_id) {
      let args: { title?: string; sql?: string; query_attachment_id?: string } = {};
      try { args = JSON.parse(item.arguments ?? '{}'); } catch { /* keep empty */ }
      if (item.name === 'execute_sql') {
        sqlCalls.set(item.call_id, { title: args.title ?? 'Query', sql: args.sql ?? '' });
        steps.push({ kind: 'sql', text: args.title ?? 'Running a query', sql: args.sql });
      } else if (item.name === 'generate_visualization' && args.query_attachment_id) {
        vizToQuery.set(item.call_id, { title: args.title ?? '', queryId: args.query_attachment_id });
        steps.push({ kind: 'viz', text: args.title ?? 'Building a chart' });
      }
    } else if (item.type === 'function_call_output' && item.call_id && sqlCalls.has(item.call_id)) {
      const t = parseMarkdownTable(item.output ?? '');
      if (t) sqlResults.set(item.call_id, t);
    }
  }

  const toChart = (id: string, title: string, queryId: string): ChartSpec | null => {
    const res = sqlResults.get(queryId);
    if (!res) return null;
    const { rows, truncated } = capRows(res.rows);
    return {
      id,
      title: title || sqlCalls.get(queryId)?.title || 'Query result',
      sql: sqlCalls.get(queryId)?.sql,
      columns: res.columns.map((name, i) => ({ name, type: inferType(rows.map((r) => r[i])) })),
      rows,
      truncated,
    };
  };

  // The final assistant message interleaves text parts with empty parts whose
  // metadata.viz.attachment_id marks where a chart belongs.
  const charts: ChartSpec[] = [];
  const messages = output.filter((o) => o.type === 'message' && o.role === 'assistant');
  const last = messages[messages.length - 1];
  const parts: string[] = [];
  for (const c of last?.content ?? []) {
    const vizId = c.metadata?.viz?.attachment_id;
    if (vizId && vizToQuery.has(vizId)) {
      const v = vizToQuery.get(vizId)!;
      const chart = toChart(vizId, v.title, v.queryId);
      if (chart) {
        charts.push(chart);
        parts.push(`\n\n[[chart:${vizId}]]\n\n`);
      }
    } else if (c.type === 'output_text' && c.text) {
      parts.push(c.text);
    }
  }
  // Visualizations the agent generated but didn't place inline.
  for (const [vizId, v] of vizToQuery) {
    if (!charts.some((c) => c.id === vizId)) {
      const chart = toChart(vizId, v.title, v.queryId);
      if (chart) charts.push(chart);
    }
  }
  // No visualization at all: still show the data behind the answer.
  if (!charts.length) {
    for (const queryId of [...sqlResults.keys()].filter((id) => (sqlResults.get(id)?.rows.length ?? 0) > 1).slice(-2)) {
      const chart = toChart(queryId, '', queryId);
      if (chart) charts.push(chart);
    }
  }
  return { version: 2, mode: 'agent', text: stripCitations(parts.join('')).trim(), charts, steps };
}
