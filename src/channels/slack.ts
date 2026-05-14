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
      return originalDeliver(platformId, threadId, message);
    };

    return bridge;
  },
});
