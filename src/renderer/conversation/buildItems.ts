import type { TaskEvent } from '../../shared/types';
import type { ChatItem } from './types';

/**
 * Consolidated SDKMessage → ChatItem builder. Replaces the three
 * parallel builders that existed before:
 *   - TaskDetail's buildChatTimeline (full detail)
 *   - WorkflowChat's buildStream (cozy)
 *   - AnswerHUD's composeAnswer (preview)
 *
 * One source of truth. Renderers decide visibility / styling per
 * kind via the `mode` prop on <Conversation>.
 *
 * Tool calls and their matching tool_results get folded into a
 * single `tool` item via tool_use_id so the UI can render them as
 * one collapsible row. System ('thinking') events are emitted as
 * their own kind so cozy mode can show them as a dim single line.
 */

export function buildItems(events: TaskEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolIndexById = new Map<string, number>();

  for (const event of events) {
    const msg = event.msg as
      | ({ type?: string } & Record<string, unknown>)
      | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const ts = event.ts;

    if (msg.type === 'assistant') {
      const content = (msg['message'] as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          const text = (block['text'] as string).trim();
          if (text) {
            items.push({
              kind: 'assistant',
              key: `${event.seq}-a-${items.length}`,
              ts,
              text,
            });
          }
        } else if (
          block['type'] === 'tool_use' &&
          typeof block['name'] === 'string'
        ) {
          const id =
            typeof block['id'] === 'string' ? (block['id'] as string) : null;
          const idx = items.length;
          const name = block['name'] as string;
          items.push({
            kind: 'tool',
            key: `${event.seq}-t-${idx}`,
            ts,
            name,
            input: block['input'],
            preview: toolPreview(block['input']),
            result: null,
            isError: false,
          });
          if (id) toolIndexById.set(id, idx);
        }
      }
      continue;
    }

    if (msg.type === 'user') {
      const content = (msg['message'] as { content?: unknown })?.content;
      if (Array.isArray(content)) {
        // Tool results land as user messages — fold them into the
        // matching tool entry so they share one collapsible row.
        let consumedAsResult = false;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block['type'] === 'tool_result') {
            const id =
              typeof block['tool_use_id'] === 'string'
                ? (block['tool_use_id'] as string)
                : null;
            const { text } = toolResultBody(block['content']);
            const isError = block['is_error'] === true;
            if (id && toolIndexById.has(id)) {
              const idx = toolIndexById.get(id)!;
              const tool = items[idx] as ChatItem & { kind: 'tool' };
              tool.result = text;
              tool.isError = isError || tool.isError;
              consumedAsResult = true;
            } else {
              // Orphan result — render as its own tool row with no name.
              items.push({
                kind: 'tool',
                key: `${event.seq}-r-${items.length}`,
                ts,
                name: 'result',
                input: null,
                preview: null,
                result: text,
                isError,
              });
              consumedAsResult = true;
            }
          }
        }
        if (consumedAsResult) continue;
        // Plain user text + any image blocks attached.
        const blocks = content as Array<Record<string, unknown>>;
        const text = blocks
          .filter(
            (b) => b['type'] === 'text' && typeof b['text'] === 'string',
          )
          .map((b) => b['text'] as string)
          .join('')
          .trim();
        const images = blocks
          .filter((b) => b['type'] === 'image')
          .map((b) => {
            const src = b['source'] as
              | { type?: string; media_type?: string; data?: string }
              | undefined;
            if (
              !src ||
              src.type !== 'base64' ||
              typeof src.media_type !== 'string' ||
              typeof src.data !== 'string'
            ) {
              return null;
            }
            return { dataUrl: `data:${src.media_type};base64,${src.data}` };
          })
          .filter((x): x is { dataUrl: string } => x !== null);
        if (text || images.length > 0) {
          items.push({
            kind: 'user',
            key: `${event.seq}-u`,
            ts,
            text,
            ...(images.length > 0 ? { images } : {}),
          });
        }
        continue;
      }
      if (typeof content === 'string' && content.trim()) {
        items.push({
          kind: 'user',
          key: `${event.seq}-u`,
          ts,
          text: content.trim(),
        });
      }
      continue;
    }

    if (msg.type === 'result') {
      const r = msg as { total_cost_usd?: number; duration_ms?: number };
      items.push({
        kind: 'result',
        key: `${event.seq}-final`,
        ts,
        durationMs: r.duration_ms ?? 0,
        costUsd: r.total_cost_usd ?? 0,
      });
      continue;
    }

    if (msg.type === 'system') {
      const m = msg as { subtype?: string };
      items.push({
        kind: 'thinking',
        key: `${event.seq}-sys`,
        ts,
        subtype: m.subtype ?? 'system',
        body: JSON.stringify(msg, null, 2),
      });
      continue;
    }

    if (msg.type === 'jarvis_error') {
      items.push({
        kind: 'error',
        key: `${event.seq}-err`,
        ts,
        body: String(msg['error'] ?? ''),
        aborted: !!msg['aborted'],
      });
      continue;
    }
  }

  return items;
}

/**
 * Tool-result content shape: string OR array of {type:'text', text}
 * blocks. Normalize to one string the UI can render in a `<pre>`.
 */
export function toolResultBody(content: unknown): {
  text: string;
  isError: boolean;
} {
  if (typeof content === 'string') return { text: content, isError: false };
  if (Array.isArray(content)) {
    const parts = (content as Array<Record<string, unknown>>).map((b) =>
      b['type'] === 'text' && typeof b['text'] === 'string'
        ? (b['text'] as string)
        : JSON.stringify(b),
    );
    return { text: parts.join('\n'), isError: false };
  }
  return { text: JSON.stringify(content, null, 2), isError: false };
}

/**
 * One-line preview of a tool call's input — picks the first
 * identifying arg (path, command, url, query…). Keeps the cozy
 * collapsed row compact while still showing what the tool is
 * touching.
 */
export function toolPreview(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const key of [
    'file_path',
    'path',
    'filename',
    'command',
    'url',
    'query',
    'pattern',
    'description',
    'prompt',
  ]) {
    const v = i[key];
    if (typeof v === 'string' && v.trim()) {
      const compact = v.length > 90 ? v.slice(0, 90) + '…' : v;
      return compact.replace(/\n/g, ' ');
    }
  }
  return null;
}
