import { streamAgentResponse } from './agentMode.js';
import {
  agentAnswer, agentEvidence, agentMessageId, agentQueries, chatAnswer, chatEvidence, chatQueries,
  type Answer, type Evidence, type QueryRun,
} from './answers.js';

/** `GenieStreamEvent` isn't part of `@databricks/appkit`'s public export
 * surface (only its internal `shared/src/genie.js`) — mirrored here rather
 * than deep-importing a non-public path that could move between versions. */
export type GenieStreamEvent =
  | { type: 'message_start'; conversationId: string; messageId: string; spaceId: string }
  | { type: 'status'; status: string }
  | {
      type: 'message_result';
      message: { content: string; status: string; error?: string; attachments?: unknown[] };
    }
  | { type: 'query_result'; attachmentId: string; statementId: string; data: unknown }
  | { type: 'error'; error: string }
  | { type: 'history_info'; conversationId: string; spaceId: string; nextPageToken: string | null; loadedCount: number };

export interface GenieLike {
  // Plain (service-principal) call — `asUser(req).sendMessage(...)` throws
  // "Cannot read properties of undefined (reading 'resolveSpaceId')" in
  // this AppKit version; the app calls Genie as its own service principal.
  sendMessage: (alias: string, content: string, conversationId?: string) => AsyncGenerator<GenieStreamEvent>;
}

export type Mode = 'chat' | 'agent';

export interface GenieRun {
  answer: Answer | null;
  queries: QueryRun[];
  /** All query results behind the answer, for the faithfulness judge (not stored). */
  evidence: Evidence[];
  conversationId: string | undefined;
  genieMessageId: string | null;
  /** Where the time went: how long each stage took, in order. */
  timeline: Array<{ stage: string; ms: number }>;
  success: boolean;
  errorMessage: string | null;
  latencyMs: number;
}

/** Genie Chat-mode statuses, as the stage names shown in Monitoring. */
const STAGE_NAMES: Record<string, string> = {
  SUBMITTED: 'Queued',
  FETCHING_METADATA: 'Reading table metadata',
  FILTERING_CONTEXT: 'Selecting relevant context',
  ASKING_AI: 'Writing SQL',
  PENDING_WAREHOUSE: 'Waiting for warehouse',
  EXECUTING_QUERY: 'Running SQL',
  COMPLETED: 'Finishing',
};

const GENIE_SPACE_ID = process.env.DATABRICKS_GENIE_SPACE_ID ?? '';

/**
 * Asks Genie one question in Chat or Agent mode and returns the normalized
 * answer with its SQL, timings and Genie ids. Used for live questions and for
 * pre-warming the answer cache, so both produce exactly the same answer shape.
 */
export async function runGenie(
  genie: GenieLike,
  mode: Mode,
  question: string,
  conversationId?: string,
  onProgress: (p: { kind: string; text: string }) => void = () => {},
): Promise<GenieRun> {
  const startedAt = Date.now();
  const run: GenieRun = {
    answer: null, queries: [], evidence: [], conversationId, genieMessageId: null, timeline: [], success: false, errorMessage: null, latencyMs: 0,
  };
  let lapStart = startedAt;
  const lap = (stage: string) => {
    const now = Date.now();
    run.timeline.push({ stage, ms: now - lapStart });
    lapStart = now;
  };

  try {
    if (mode === 'agent') {
      if (!GENIE_SPACE_ID) throw new Error('DATABRICKS_GENIE_SPACE_ID is not configured');
      for await (const evt of streamAgentResponse(GENIE_SPACE_ID, question, run.conversationId)) {
        const d = evt.data as Record<string, unknown>;
        if (evt.type === 'response.output_item.done') {
          const step = agentProgress((d?.item ?? {}) as Record<string, unknown>);
          onProgress(step);
          if (step.kind !== 'other') lap(agentStageName(step));
        } else if (evt.type === 'response.completed' && d?.response) {
          const responseObj = d.response as { conversation_id?: string; output?: unknown[] };
          run.conversationId = responseObj.conversation_id ?? run.conversationId;
          const output = (responseObj.output ?? []) as never;
          run.answer = agentAnswer(output);
          run.queries = agentQueries(output);
          run.evidence = agentEvidence(output);
          run.genieMessageId = agentMessageId(output);
          run.success = Boolean(run.answer.text);
        } else if (evt.type === 'response.failed' || evt.type === 'error') {
          run.errorMessage = JSON.stringify(d?.error ?? d);
        }
      }
      lap('Finishing');
    } else {
      let attachments: unknown[] = [];
      const queryResults = new Map<string, never>();
      let stage = 'Sending the question';
      for await (const evt of genie.sendMessage('default', question, run.conversationId)) {
        if (evt.type === 'message_start') {
          run.conversationId = evt.conversationId;
          run.genieMessageId = evt.messageId;
        } else if (evt.type === 'status') {
          onProgress({ kind: 'status', text: evt.status });
          const next = STAGE_NAMES[evt.status] ?? evt.status;
          if (next !== stage) { lap(stage); stage = next; }
        } else if (evt.type === 'message_result') {
          lap(stage);
          stage = 'Fetching result rows';
          attachments = evt.message.attachments ?? [];
          run.success = evt.message.status !== 'FAILED';
          if (evt.message.error) run.errorMessage = evt.message.error;
        } else if (evt.type === 'query_result') {
          queryResults.set(evt.attachmentId, evt.data as never);
        } else if (evt.type === 'error') {
          run.errorMessage = evt.error;
        }
      }
      lap(stage);
      run.answer = chatAnswer(attachments as never, queryResults);
      run.queries = chatQueries(attachments as never, queryResults);
      run.evidence = chatEvidence(attachments as never, queryResults);
      if (!run.answer.text && !run.answer.charts.length) run.success = false;
    }
  } catch (err) {
    run.errorMessage = err instanceof Error ? err.message : String(err);
  }
  run.latencyMs = Date.now() - startedAt;
  return run;
}

/** Stage name for the Monitoring timeline; the time is what led up to this step finishing. */
function agentStageName(step: { kind: string; text: string }): string {
  const t = step.text.length > 70 ? step.text.slice(0, 70) + '…' : step.text;
  switch (step.kind) {
    case 'reasoning': return 'Reasoning';
    case 'sql': return `Running SQL: ${t}`;
    case 'viz': return `Building chart: ${t}`;
    case 'writing': return 'Writing the answer';
    default: return t || 'Working';
  }
}

/** A short, human-readable line for each finished Agent Mode step. */
function agentProgress(item: Record<string, unknown>): { kind: string; text: string } {
  if (item.type === 'reasoning') {
    const content = (item.content ?? []) as Array<{ text?: string }>;
    return { kind: 'reasoning', text: content.map((c) => c.text ?? '').join(' ').trim() || 'Thinking…' };
  }
  if (item.type === 'function_call') {
    let args: { title?: string } = {};
    try { args = JSON.parse(String(item.arguments ?? '{}')); } catch { /* keep empty */ }
    if (item.name === 'execute_sql') return { kind: 'sql', text: args.title ?? 'Running a query' };
    if (item.name === 'generate_visualization') return { kind: 'viz', text: args.title ?? 'Building a chart' };
    return { kind: 'tool', text: String(item.name ?? 'Working') };
  }
  if (item.type === 'message') return { kind: 'writing', text: 'Writing the answer' };
  return { kind: 'other', text: '' };
}
