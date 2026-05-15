/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Adds a Slack-specific outbound interceptor for `content.type === 'blocks'`:
 * raw Block Kit emitted by Bo's `send_blocks` MCP tool bypasses the
 * cross-platform chat-adapter abstraction (which only understands the
 * CardElement schema) and POSTs directly to `chat.postMessage` with the
 * blocks array. Required because the chat-adapter has no pass-through path
 * for native Block Kit primitives — it generates blocks from CardElement
 * or markdown tables, never accepts them verbatim.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const SLACK_API = 'https://slack.com/api/chat.postMessage';

interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

async function postBlocksDirect(
  botToken: string,
  channel: string,
  threadTs: string | undefined,
  blocks: unknown[],
  fallbackText: string,
): Promise<string | undefined> {
  const body: Record<string, unknown> = {
    channel,
    blocks,
    text: fallbackText,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (threadTs) body.thread_ts = threadTs;

  const res = await fetch(SLACK_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SlackPostResult;
  if (!json.ok) {
    log.warn('Slack chat.postMessage(blocks) failed', { error: json.error, channel, threadTs });
    return undefined;
  }
  return json.ts;
}

/**
 * Detect GFM-style markdown tables: a line with at least two `|` separators
 * immediately followed by an alignment separator row (`|---|---|`). Returns
 * the line indices where tables start.
 */
function findTableStarts(text: string): number[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (!header || !sep) continue;
    if ((header.match(/\|/g) ?? []).length < 2) continue;
    if (!/^[\s|:-]+$/.test(sep)) continue;
    if ((sep.match(/-/g) ?? []).length < 2) continue;
    starts.push(i);
  }
  return starts;
}

function countMarkdownTables(text: string): number {
  return findTableStarts(text).length;
}

/**
 * Split text on table boundaries so each resulting chunk contains at most one
 * table (plus any prose immediately before it). Preserves prose order. Empty
 * trailing chunks dropped.
 */
function splitOnMarkdownTables(text: string): string[] {
  const lines = text.split('\n');
  const starts = findTableStarts(text);
  if (starts.length <= 1) return [text];

  // For each table start, find where the table ends (first non-pipe line
  // after the alignment separator). Then split on table boundaries.
  const tableRanges: Array<{ start: number; end: number }> = [];
  for (const start of starts) {
    let end = start + 2; // header + separator already accounted for
    while (end < lines.length && lines[end].includes('|') && lines[end].trim() !== '') {
      end++;
    }
    tableRanges.push({ start, end });
  }

  // Build chunks: prose from previous table end (or 0) up to the next table's
  // end, then the next table goes with the prose AFTER its end.
  // Strategy: each chunk = optional prose + exactly one table.
  const chunks: string[] = [];
  let cursor = 0;
  for (let idx = 0; idx < tableRanges.length; idx++) {
    const { start, end } = tableRanges[idx];
    const nextStart = idx + 1 < tableRanges.length ? tableRanges[idx + 1].start : lines.length;
    // chunk spans cursor → max(end, just before next table). Include prose
    // up to next table so trailing context stays attached to its table.
    const chunkEnd = nextStart;
    chunks.push(lines.slice(cursor, chunkEnd).join('\n').trim());
    cursor = chunkEnd;
    // Suppress unused-var: ensure we reference start/end somewhere
    void start;
    void end;
  }
  // Final prose chunk (after the last table) if any
  if (cursor < lines.length) {
    const trailing = lines.slice(cursor).join('\n').trim();
    if (trailing) chunks.push(trailing);
  }
  return chunks.filter((c) => c.length > 0);
}

// platformId / threadId from the routing layer are encoded as
// `slack:<channelId>` or `slack:<channelId>:<threadTs>`. Decode here rather
// than reaching for the adapter's private decodeThreadId.
function decodeRouting(platformId: string, threadId: string | null): { channel: string; threadTs?: string } | null {
  const id = threadId ?? platformId;
  const parts = id.replace(/^slack:/, '').split(':');
  if (parts.length === 0 || !parts[0]) return null;
  return { channel: parts[0], threadTs: parts[1] || undefined };
}

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const botToken = env.SLACK_BOT_TOKEN;
    const slackAdapter = createSlackAdapter({
      botToken,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };

    // Wrap deliver: intercept `{type: 'blocks', blocks, fallbackText}` and
    // post directly. Everything else flows through the bridge unchanged.
    //
    // Also: if a plain-text outbound contains more than one GFM markdown
    // table, split into separate posts. Slack's adapter generates exactly
    // one rich_text_table block per chat.postMessage call; additional tables
    // in the same body fall back to ASCII inside a code fence (which looks
    // broken). Joel has corrected Bo on this repeatedly; enforce it host-side
    // so Bo doesn't have to remember it.
    const originalDeliver = bridge.deliver.bind(bridge);
    bridge.deliver = async (platformId, threadId, message) => {
      const content = (message.content ?? {}) as Record<string, unknown>;
      if (content.type === 'blocks' && Array.isArray(content.blocks)) {
        const routing = decodeRouting(platformId, threadId);
        if (!routing) {
          log.warn('Slack blocks deliver: failed to decode routing', { platformId, threadId });
          return undefined;
        }
        return postBlocksDirect(
          botToken,
          routing.channel,
          routing.threadTs,
          content.blocks,
          (content.fallbackText as string) || '',
        );
      }

      // Multi-table splitter (markdown body path)
      const text = (content.text as string) || (content.markdown as string) || '';
      if (text && countMarkdownTables(text) > 1) {
        const chunks = splitOnMarkdownTables(text);
        log.info('Slack multi-table splitter: splitting outbound', {
          platformId,
          threadId,
          tables: chunks.length,
        });
        let firstId: string | undefined;
        for (let i = 0; i < chunks.length; i++) {
          const chunkMessage = { ...message, content: { ...content, text: chunks[i] } };
          // Drop markdown field if present so chat-sdk-bridge picks up text
          // path uniformly. The bridge tries `markdown` before `text`.
          delete (chunkMessage.content as Record<string, unknown>).markdown;
          const id = await originalDeliver(platformId, threadId, chunkMessage);
          if (i === 0) firstId = id;
        }
        return firstId;
      }

      return originalDeliver(platformId, threadId, message);
    };

    return bridge;
  },
});
