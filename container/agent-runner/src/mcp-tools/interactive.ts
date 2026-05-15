/**
 * Interactive MCP tools: ask_user_question, send_card, send_blocks.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 *
 * send_blocks is Slack-specific raw Block Kit pass-through for cases where
 * send_card's cross-platform Card schema isn't expressive enough (section
 * blocks with fields, headers, dividers, etc.).
 */
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();

    // Write question card to outbound.db
    writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        options,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}" [${options.join(', ')}]`);

    // Poll for response in inbound.db (host writes the response there)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a structured card (interactive or display-only) to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description: 'Card structure with title, description, and optional children/actions',
        },
        fallbackText: { type: 'string', description: 'Text fallback for platforms without card support' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}`);
    return ok(`Card sent (id: ${id})`);
  },
};

export const inspectMessage: McpToolDefinition = {
  tool: {
    name: 'inspect_message',
    description:
      'Fetch a previously-sent Slack message via conversations.history and return the actual Block Kit block types Slack rendered. Use whenever Joel asks "did that render?" or before claiming a message rendered as a table. Pass the integer message id you sent (the #N shown when send_message / send_blocks returned). Returns blockTypes, tableCount (count of rich_text_table blocks), hasFieldsSection (true if any section block uses fields — the cramped 2-col layout). Never claim a rendering verdict without calling this first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: {
          type: 'integer',
          description: 'The numeric message id (the seq shown when the message was sent).',
        },
      },
      required: ['messageId'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    if (!Number.isFinite(seq) || seq <= 0) return err('messageId must be a positive integer');

    // Look up the platform message id (Slack ts) from the outbound DB + delivered table.
    // The container has read access to inbound.db; delivered table is on outbound.db
    // (mounted as well). Use the local sqlite via the existing helpers.
    const r = routing();
    if (r.channel_type !== 'slack') {
      return err(`inspect_message only works for slack destinations (current: ${r.channel_type ?? 'unknown'})`);
    }
    const channelId = (r.platform_id || '').replace(/^slack:/, '').split(':')[0];
    if (!channelId) return err('could not derive Slack channel id from routing');

    // Pull the Slack ts (platform_message_id) from outbound.db's `delivered` table.
    // Use better-sqlite3 directly since this is read-only and outbound is on the same disk.
    let platformMsgId: string | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3') as typeof import('better-sqlite3');
      const db = new Database('/workspace/outbound.db', { readonly: true });
      try {
        const row = db
          .prepare(
            `SELECT d.platform_message_id
             FROM delivered d
             JOIN messages_out m ON m.id = d.message_out_id
             WHERE m.seq = ?
             ORDER BY d.delivered_at DESC LIMIT 1`,
          )
          .get(seq) as { platform_message_id: string | null } | undefined;
        platformMsgId = row?.platform_message_id ?? null;
      } finally {
        db.close();
      }
    } catch (e) {
      return err(`failed to read delivered table: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!platformMsgId) return err(`message #${seq} has no delivered platform_message_id yet — was it actually sent and accepted by Slack?`);

    // Thread replies require conversations.replies (not history). Derive
    // thread_ts from routing.thread_id, which is encoded as
    // slack:<channel>:<thread_ts>; absent if it's a top-level channel post.
    const threadParts = (r.thread_id || '').replace(/^slack:/, '').split(':');
    const threadTs = threadParts.length === 2 ? threadParts[1] : '';

    // Call the host helium-api endpoint to fetch and summarise.
    const qs = new URLSearchParams({ channel: channelId, ts: platformMsgId });
    if (threadTs) qs.set('thread_ts', threadTs);
    const url = `http://host.docker.internal:9224/slack/inspect?${qs.toString()}`;
    try {
      const res = await fetch(url);
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return err(`inspect endpoint returned ${res.status}: ${JSON.stringify(json)}`);
      }
      // Return a concise summary at the top so a quick scan answers Joel's
      // typical "did that render as a table?" without forcing him to read
      // the raw blocks dump. rawBlocks is still in the payload for deep dives.
      return ok(JSON.stringify(json, null, 2));
    } catch (e) {
      return err(`failed to call inspect endpoint: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const sendBlocks: McpToolDefinition = {
  tool: {
    name: 'send_blocks',
    description:
      'Send raw Slack Block Kit blocks. Use this when the cross-platform send_card schema is not expressive enough — e.g. section blocks with fields, header blocks, dividers between sections, accessory elements. Slack-only; non-Slack destinations receive the fallbackText instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name. Optional if you have only one destination.',
        },
        blocks: {
          type: 'array',
          description:
            'Array of Slack Block Kit block objects (each with a top-level `type` field like "header", "section", "divider", etc.). Posted via chat.postMessage with the blocks field.',
        },
        fallbackText: {
          type: 'string',
          description:
            'Plain text shown in Slack notifications and used as the message body on non-Slack destinations. Required — without it the message is unreadable in mobile push and previews.',
        },
      },
      required: ['blocks', 'fallbackText'],
    },
  },
  async handler(args) {
    const blocks = args.blocks;
    const fallbackText = args.fallbackText as string;
    if (!Array.isArray(blocks) || blocks.length === 0) return err('blocks must be a non-empty array');
    if (!fallbackText || typeof fallbackText !== 'string') {
      return err('fallbackText is required (used for notifications and non-Slack fallback)');
    }

    const id = generateId();
    const r = routing();
    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'blocks', blocks, fallbackText }),
    });

    log(`send_blocks: ${id} (${blocks.length} blocks)`);
    return ok(`Block Kit message sent (id: ${id}, ${blocks.length} blocks)`);
  },
};

registerTools([askUserQuestion, sendCard, sendBlocks, inspectMessage]);
