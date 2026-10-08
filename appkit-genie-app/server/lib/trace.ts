/**
 * A request trace: every step of answering one question as a span with its
 * start offset and duration, so Monitoring and the "How this answer was made"
 * panel can draw it as a waterfall (the same shape as an OpenTelemetry trace).
 */

export type SpanKind = 'guardrail' | 'cache' | 'engine' | 'model' | 'app';

export interface Span {
  name: string;
  kind: SpanKind;
  start: number; // ms after the question arrived
  ms: number;
  detail?: string;
  parent?: string;
}

export class Trace {
  readonly t0 = Date.now();
  readonly spans: Span[] = [];

  now(): number { return Date.now() - this.t0; }

  add(name: string, kind: SpanKind, start: number, ms: number, detail?: string, parent?: string): void {
    this.spans.push({ name, kind, start: Math.max(0, start), ms: Math.max(0, ms), ...(detail ? { detail } : {}), ...(parent ? { parent } : {}) });
  }

  /** Times fn as one span; the span is recorded even if fn throws. */
  async time<T>(name: string, kind: SpanKind, fn: () => Promise<T>, detail?: string): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } finally {
      this.add(name, kind, start, this.now() - start, detail);
    }
  }

  /** The query engine's own stages, laid end to end inside its span. */
  addStages(parent: string, start: number, stages: Array<{ stage: string; ms: number }>): void {
    let at = start;
    for (const s of stages) {
      if (s.ms > 0) this.add(s.stage, 'engine', at, s.ms, undefined, parent);
      at += s.ms;
    }
  }

  toJSON(): Span[] { return [...this.spans].sort((a, b) => a.start - b.start); }
}

/** The certified views a set of SQL statements read from, by short name. */
export function sourcesFromSql(sqls: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const sql of sqls) {
    if (!sql) continue;
    for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+`?([\w.`]+)`?/gi)) {
      const full = m[1].replace(/`/g, '');
      const name = full.split('.').pop() ?? '';
      if (/_gold\./i.test(full) || /^(qry|mv)_|^business_rules_config$/i.test(name)) out.add(name);
    }
  }
  return [...out];
}
