import { getExecutionContext } from '@databricks/appkit';

export interface AgentStreamEvent {
  type: string;
  data: unknown;
}

/**
 * Calls the Genie Agent Mode "responses" API and yields parsed SSE events.
 *
 * Uses the low-level `apiClient.request({ raw: true })` escape hatch because
 * this SDK build has no typed wrapper for the Agent Mode endpoint yet — it's
 * newer than the pinned `@databricks/sdk-experimental` version. Confirmed by
 * reading the compiled `api-client.js`: `raw: true` returns
 * `{ contents: ReadableStream<Uint8Array> }`, not `{ body }` as the .d.ts
 * comment's naming might suggest — a plain `.body` read would have silently
 * returned `undefined`.
 */
export async function* streamAgentResponse(
  agentId: string,
  content: string,
  conversationId?: string,
): AsyncGenerator<AgentStreamEvent> {
  const ctx = getExecutionContext();
  const client = ctx.client;

  const payload: Record<string, unknown> = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: content }],
      },
    ],
    enable_viz: true,
  };
  if (conversationId) payload.conversation_id = conversationId;

  const result = (await client.apiClient.request({
    path: `/api/2.0/genie/agents/${agentId}/responses`,
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }),
    raw: true,
    payload,
  } as never)) as { contents: ReadableStream<Uint8Array> };

  const reader = result.contents.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let eventType = 'message';
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const rawData = dataLines.join('\n');
      if (!rawData) continue;
      try {
        yield { type: eventType, data: JSON.parse(rawData) };
      } catch {
        yield { type: eventType, data: rawData };
      }
    }
  }
}

/** Pulls the final assistant text out of a completed Agent Mode response object. */
export function extractFinalText(responseObject: {
  output?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>;
}): string {
  const messages = (responseObject.output ?? []).filter(
    (item) => item.type === 'message' && item.role === 'assistant',
  );
  const last = messages[messages.length - 1];
  if (!last?.content) return '';
  return last.content
    .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}
