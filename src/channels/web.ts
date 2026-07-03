/**
 * Web channel adapter — HTTP API that speaks a subset of the Anthropic
 * Messages API so LibreChat (or any Anthropic-compatible frontend) can
 * talk to NanoClaw agents.
 *
 * Architecture:
 *   LibreChat → POST /v1/messages → this adapter → NanoClaw router
 *   This adapter tails the SDK transcript jsonl and streams back
 *   Anthropic-format SSE events (thinking, tool_use, text).
 *
 * The adapter is a native NanoClaw channel (not a Chat SDK bridge).
 * Self-registers on import.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import Database from 'better-sqlite3';
import { log } from '../log.js';
import { getDb } from '../db/connection.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { readEnvFile } from '../env.js';

const GROUPS_DIR = path.resolve('groups');
const SESSIONS_DIR = path.resolve('data/v2-sessions');
const POLL_MS = 400;
let cachedPort: string | null = null;
let cachedBaseUrl: string | null = null;
function getPort(): string {
  if (!cachedPort) cachedPort = readEnvFile(['WEB_CHANNEL_PORT']).WEB_CHANNEL_PORT || '3090';
  return cachedPort;
}
function getFileBaseUrl(): string {
  if (!cachedBaseUrl) {
    const env = readEnvFile(['WEB_CHANNEL_URL', 'WEB_CHANNEL_PORT']);
    cachedBaseUrl = (env.WEB_CHANNEL_URL || `http://localhost:${env.WEB_CHANNEL_PORT || '3090'}`).replace(/\/+$/, '');
  }
  return cachedBaseUrl;
}
const FILE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FILE_STORE_MAX = 100;

const fileStore = new Map<string, { filename: string; data: Buffer; mime: string; expires: number }>();

function storeFile(filename: string, data: Buffer): string {
  pruneExpiredFiles();
  // Evict oldest entries if at capacity
  while (fileStore.size >= FILE_STORE_MAX) {
    const oldest = fileStore.keys().next().value;
    if (oldest) fileStore.delete(oldest);
    else break;
  }
  const token = crypto.randomBytes(16).toString('hex');
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mime = extToMime(ext);
  fileStore.set(token, { filename, data, mime, expires: Date.now() + FILE_TTL_MS });
  return token;
}

function pruneExpiredFiles(): void {
  const now = Date.now();
  for (const [token, entry] of fileStore) {
    if (entry.expires < now) fileStore.delete(token);
  }
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    pdf: 'application/pdf',
    json: 'application/json',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    xml: 'text/xml',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  };
  return map[ext] || 'application/octet-stream';
}

const TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'csv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'py',
  'sh',
  'sql',
  'log',
  'toml',
  'ini',
  'env',
  'conf',
]);

function resolveSystemPrompt(): string {
  const groupDir = path.join(GROUPS_DIR, 'web_main');
  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  const localMd = path.join(groupDir, 'CLAUDE.local.md');

  const sections: string[] = [];

  // Resolve @./ includes from CLAUDE.md
  if (fs.existsSync(claudeMd)) {
    const lines = fs.readFileSync(claudeMd, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^@\.\/(.+)$/);
      if (match) {
        const includePath = path.join(groupDir, match[1]);
        if (includePath.includes('.claude-shared.md')) {
          // Skip the container-internal symlink — read CLAUDE.local.md instead
          continue;
        }
        if (fs.existsSync(includePath)) {
          const name = path.basename(includePath, '.md');
          sections.push(`\n<!-- ═══ ${name} ═══ -->\n\n${fs.readFileSync(includePath, 'utf-8')}`);
        }
      }
    }
  }

  // CLAUDE.local.md is the main per-group customization
  let local = '';
  if (fs.existsSync(localMd)) {
    local = fs.readFileSync(localMd, 'utf-8');
  }

  // Also read the base CLAUDE.md from the repo root (the shared instructions)
  const baseMd = path.resolve('CLAUDE.md');
  let base = '';
  if (fs.existsSync(baseMd)) {
    base = fs.readFileSync(baseMd, 'utf-8');
  }

  return [
    '# Bo — System Prompt (Live)',
    '',
    '## CLAUDE.local.md (per-group personality + rules)',
    '',
    local,
    '',
    ...sections,
    '',
    '---',
    '',
    '## Base CLAUDE.md (NanoClaw core instructions)',
    '',
    base,
  ].join('\n');
}

function renderSystemPromptPage(markdown: string): string {
  const escaped = markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<link rel="icon" type="image/png" href="/favicon.png">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bo — System Prompt</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 900px; margin: 0 auto; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: 'SF Mono', 'Menlo', monospace; font-size: 13px; line-height: 1.6; background: #161b22; padding: 1.5rem; border-radius: 8px; border: 1px solid #30363d; overflow-x: auto; }
  h1 { color: #f0f6fc; margin-bottom: 0.5rem; font-size: 1.4rem; }
  .meta { color: #8b949e; font-size: 0.85rem; margin-bottom: 1.5rem; }
  a { color: #58a6ff; }
</style>
</head>
<body>
<h1>Bo — System Prompt</h1>
<p class="meta">Live from <code>groups/slack_main/</code> — <a href="/system-prompt.md">raw markdown</a> — refreshes on reload</p>
<pre>${escaped}</pre>
</body>
</html>`;
}
const STALE_MS = 300_000;

type OutputFormat = 'anthropic' | 'openai';

interface PendingRequest {
  res: http.ServerResponse;
  conversationId: string;
  sessionId: string | null;
  agentGroupId: string | null;
  jsonlPath: string | null;
  jsonlOffset: number;
  routeTimeMs: number;
  preRouteJsonlPath: string | null;
  preRouteJsonlSize: number;
  pollHandle: NodeJS.Timeout | null;
  lastActivityAt: number;
  finalized: boolean;
  finalizeTimer: NodeJS.Timeout | null;
  lastStreamedType: 'text' | 'tool_use' | 'thinking' | 'file' | null;
  partialLine: string;
  inboundMsgId: string | null;
  inboundText: string | null;
  seenOwnEnqueue: boolean;
  messageIndex: number;
  contentIndex: number;
  format: OutputFormat;
  openaiMsgId: string;
  /** True while a blocking ask_user_question awaits the user's answer —
   *  suppresses silence/stale finalization so the SSE stays open for it. */
  questionPending: boolean;
}

const pending = new Map<string, PendingRequest>();

function sseWrite(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendMessageStart(res: http.ServerResponse, messageId: string, model: string): void {
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function sendContentBlockStart(res: http.ServerResponse, index: number, block: unknown): void {
  sseWrite(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: block,
  });
}

function sendContentBlockDelta(res: http.ServerResponse, index: number, delta: unknown): void {
  sseWrite(res, 'content_block_delta', {
    type: 'content_block_delta',
    index,
    delta,
  });
}

function sendContentBlockStop(res: http.ServerResponse, index: number): void {
  sseWrite(res, 'content_block_stop', {
    type: 'content_block_stop',
    index,
  });
}

function sendMessageDelta(res: http.ServerResponse, stopReason: string): void {
  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
}

function sendMessageStop(res: http.ServerResponse): void {
  sseWrite(res, 'message_stop', { type: 'message_stop' });
}

function lookupSession(
  channelType: string,
  platformId: string,
  threadId: string | null,
): {
  sessionId: string;
  agentGroupId: string;
  threadScoped: boolean;
} | null {
  try {
    const db = getDb();
    // Per-thread session (web MG is threaded): exact thread match first.
    if (threadId) {
      const row = db
        .prepare(
          `SELECT s.id, s.agent_group_id
           FROM sessions s
           JOIN messaging_groups mg ON mg.id = s.messaging_group_id
           WHERE mg.channel_type = ? AND mg.platform_id = ? AND s.thread_id = ?
           ORDER BY s.created_at DESC LIMIT 1`,
        )
        .get(channelType, platformId, threadId) as { id?: string; agent_group_id?: string } | undefined;
      if (row?.id && row?.agent_group_id) {
        return { sessionId: row.id, agentGroupId: row.agent_group_id, threadScoped: true };
      }
    }
    // Legacy shared session (thread_id IS NULL) — holds all pre-threading
    // history. Also the target when no thread is specified.
    const row = db
      .prepare(
        `SELECT s.id, s.agent_group_id
         FROM sessions s
         JOIN messaging_groups mg ON mg.id = s.messaging_group_id
         WHERE mg.channel_type = ? AND mg.platform_id = ? AND s.thread_id IS NULL
         ORDER BY s.created_at DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { id?: string; agent_group_id?: string } | undefined;
    if (!row?.id || !row?.agent_group_id) return null;
    return { sessionId: row.id, agentGroupId: row.agent_group_id, threadScoped: false };
  } catch {
    return null;
  }
}

/**
 * Resolve the SDK transcript jsonl for a specific session via its stored
 * continuation (outbound.db session_state, `continuation:claude|<uuid>`).
 * All sessions in an agent group share one transcript directory, so
 * "latest file" heuristics pick the wrong session when several are active.
 */
function jsonlForSession(agentGroupId: string, sessionId: string): string | null {
  try {
    const dbPath = path.join(SESSIONS_DIR, agentGroupId, sessionId, 'outbound.db');
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT value FROM session_state WHERE key = 'continuation:claude'`).get() as
      | { value: string }
      | undefined;
    db.close();
    if (!row?.value) return null;
    const file = path.join(findTranscriptDir(agentGroupId), `${row.value}.jsonl`);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

// Strips machine-injected context blocks from a legacy era when replies
// to stale threads carried replayed history (pre per-thread sessions).
const THREAD_CONTEXT_RE = /<thread-context>[\s\S]*?<\/thread-context>\s*/;

function findTranscriptDir(agentGroupId: string): string {
  return path.join(SESSIONS_DIR, agentGroupId, '.claude-shared/projects/-workspace-agent');
}

function findLatestJsonl(dir: string, afterMs: number): string | null {
  if (!fs.existsSync(dir)) return null;
  const tolerance = 5_000;
  let best: string | null = null;
  let bestMtime = -1;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      if (stat.birthtimeMs < afterMs - tolerance) continue;
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = full;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

function findAnyLatestJsonl(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let best: string | null = null;
  let bestMtime = -1;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = full;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

interface TranscriptEvent {
  type?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
    stop_reason?: string;
    model?: string;
  };
}

function stripMessageTags(text: string): string {
  let cleaned = text
    .replace(/<message[^>]*>([\s\S]*?)<\/message>/g, '$1')
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .trim();
  return cleaned;
}

const SILENCE_FALLBACK_MS = 60_000;

function updateStreamState(req: PendingRequest, blockType: 'text' | 'tool_use' | 'thinking' | 'file'): void {
  req.lastStreamedType = blockType;
  req.lastActivityAt = Date.now();

  // Reset the fallback safety timer on any event. The primary finalization
  // signal is stop_reason=end_turn in processTranscriptEvents — this timer
  // only fires if that signal never arrives (crash, hang, etc.).
  if (req.finalizeTimer) clearTimeout(req.finalizeTimer);
  // While a question is pending the agent is blocked waiting for the user —
  // don't arm the silence timer, or we'd close the stream before they answer.
  if (req.questionPending) return;
  req.finalizeTimer = setTimeout(() => finalize(req, 'silence-fallback'), SILENCE_FALLBACK_MS);
}

function openaiChunk(req: PendingRequest, content: string, finishReason: string | null = null): void {
  const data = {
    id: req.openaiMsgId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'bo',
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  };
  try {
    if (!req.res.writableEnded) req.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client disconnected */
  }
  req.lastActivityAt = Date.now();
}

function resolveGroupDir(agentGroupId: string | null): string | null {
  if (!agentGroupId) return null;
  try {
    const row = getDb().prepare('SELECT folder FROM agent_groups WHERE id = ?').get(agentGroupId) as
      | { folder: string }
      | undefined;
    if (!row?.folder) return null;
    const dir = path.resolve(GROUPS_DIR, row.folder);
    if (!dir.startsWith(GROUPS_DIR + '/') && dir !== GROUPS_DIR) return null;
    return dir;
  } catch {
    return null;
  }
}

function inlineFileContent(req: PendingRequest, filePath: string): void {
  const groupDir = resolveGroupDir(req.agentGroupId);
  if (!groupDir) {
    log.warn('inlineFileContent: no group dir', { agentGroupId: req.agentGroupId });
    return;
  }
  // Map container paths (/workspace/agent/...) to the host group directory.
  let resolved: string;
  if (filePath.startsWith('/workspace/agent/')) {
    resolved = path.resolve(groupDir, filePath.slice('/workspace/agent/'.length));
  } else if (filePath.startsWith('/')) {
    resolved = path.join(groupDir, path.basename(filePath));
  } else {
    resolved = path.resolve(groupDir, filePath);
  }
  if (!resolved.startsWith(groupDir + '/') && resolved !== groupDir) {
    log.warn('inlineFileContent: path escapes group dir', { filePath, resolved, groupDir });
    return;
  }
  try {
    if (!fs.existsSync(resolved)) {
      log.warn('inlineFileContent: file not found', { filePath, resolved });
      return;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return;
    if (stat.size > 50 * 1024 * 1024) {
      log.warn('inlineFileContent: file too large', { resolved, size: stat.size });
      return;
    }
    const data = fs.readFileSync(resolved);
    const filename = path.basename(resolved);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const mime = extToMime(ext);

    const parts: string[] = [];
    const token = storeFile(filename, data);
    const downloadUrl = `${getFileBaseUrl()}/files/${token}/${encodeURIComponent(filename)}`;
    if (mime.startsWith('image/') && data.length <= 256 * 1024) {
      parts.push(`![${filename}](data:${mime};base64,${data.toString('base64')})`);
    } else if (mime.startsWith('image/')) {
      parts.push(`[![${filename}](${downloadUrl})](${downloadUrl})`);
    } else {
      parts.push(`[📎 ${filename}](${downloadUrl})`);
      if (TEXT_EXTENSIONS.has(ext) && data.length < 32_768) {
        const lang = ext === 'md' ? 'markdown' : ext;
        parts.push(`\`\`\`${lang}\n${data.toString('utf-8')}\n\`\`\``);
      }
    }
    const content = parts.join('\n\n');
    if (req.format === 'openai') {
      openaiChunk(req, content);
      updateStreamState(req, 'file');
    } else {
      sendContentBlockStart(req.res, req.contentIndex, { type: 'text', text: '' });
      sendContentBlockDelta(req.res, req.contentIndex, { type: 'text_delta', text: content });
      sendContentBlockStop(req.res, req.contentIndex);
      req.contentIndex++;
      updateStreamState(req, 'file');
    }
  } catch (e) {
    log.warn('inlineFileContent: error reading file', { filePath, resolved, error: String(e) });
  }
}

function extractToolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (item.type === 'text' && typeof item.text === 'string') {
        texts.push(item.text.trim());
      } else if (item.type === 'image') {
        texts.push('[image]');
      }
    }
    return texts.join('\n') || null;
  }
  return null;
}

function summarizeToolResult(result: string): string {
  // Strip Node.js warnings from the start
  const cleaned = result
    .replace(/^\(node:\d+\).*\n?/gm, '')
    .replace(/^Warning:.*\n?/gm, '')
    .trim();
  if (!cleaned) return '';

  // Errors — show clearly
  if (cleaned.startsWith('Error:') || cleaned.includes('ENOENT') || cleaned.includes('EACCES')) {
    return `\n\`⚠️ ${cleaned.split('\n')[0].slice(0, 120)}\`\n`;
  }

  // Success messages from nanoclaw tools
  if (cleaned.startsWith('Message sent') || cleaned.startsWith('File sent')) {
    return `\n\`✅ ${cleaned.split('\n')[0].slice(0, 100)}\`\n`;
  }

  // Short results — show directly
  const singleLine = cleaned.replace(/\n/g, ' ').replace(/\s+/g, ' ');
  if (singleLine.length <= 150) {
    return `\n\`→ ${singleLine}\`\n`;
  }

  // Multi-line results — show count + first line
  const lines = cleaned.split('\n').filter((l) => l.trim());
  const firstLine = lines[0]?.slice(0, 80) || '';
  if (lines.length > 1) {
    return `\n\`📋 ${lines.length} lines: ${firstLine}…\`\n`;
  }

  // Long single-line — truncate
  return `\n\`→ ${singleLine.slice(0, 120)}…\`\n`;
}

function formatToolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const cleanName = name.replace(/^mcp__/, '').replace(/__/g, '.');
  const desc = input?.description as string | undefined;
  if (desc) return `\n\`🔧 ${desc}\`\n`;

  // Build a descriptive label from the tool input
  if (name === 'Glob' || name === 'glob') {
    const pattern = input?.pattern as string;
    return `\n\`🔍 Searching: ${pattern || '...'}\`\n`;
  }
  if (name === 'Read' || name === 'read') {
    const fp = input?.file_path as string;
    return `\n\`📖 Reading ${fp ? path.basename(fp) : '...'}\`\n`;
  }
  if (name === 'Write' || name === 'write') {
    const fp = input?.file_path as string;
    return `\n\`✏️ Writing ${fp ? path.basename(fp) : '...'}\`\n`;
  }
  if (name === 'Edit' || name === 'edit') {
    const fp = input?.file_path as string;
    return `\n\`✏️ Editing ${fp ? path.basename(fp) : '...'}\`\n`;
  }
  if (name === 'ToolSearch') {
    const q = input?.query as string;
    return `\n\`🔍 Finding tools: ${q ? q.slice(0, 60) : '...'}\`\n`;
  }
  if (name === 'Skill') {
    const s = input?.skill as string;
    return `\n\`⚡ Running /${s || '...'}\`\n`;
  }
  if (cleanName.includes('web_search')) {
    const q = (input?.search_queries as string[] | undefined)?.[0] || (input?.objective as string) || '';
    return `\n\`🌐 Searching: ${q.slice(0, 60)}\`\n`;
  }
  if (cleanName.includes('web_fetch')) {
    const urls = input?.urls as string[] | undefined;
    const url = urls?.[0] || (input?.url as string) || '';
    const domain = url ? new URL(url).hostname : '...';
    return `\n\`🌐 Fetching ${domain}\`\n`;
  }
  if (cleanName.includes('send_file')) {
    const fp = input?.path as string;
    return `\n\`📤 Sending ${fp ? path.basename(fp) : 'file'}\`\n`;
  }
  if (cleanName.includes('send_message')) {
    return `\n\`💬 Sending message\`\n`;
  }
  if (cleanName.includes('send_blocks')) {
    return `\n\`📊 Sending formatted content\`\n`;
  }
  if (cleanName.includes('schedule_task')) {
    return `\n\`📅 Scheduling task\`\n`;
  }
  if (cleanName.includes('ask_user')) {
    return `\n\`❓ Asking you a question\`\n`;
  }
  // MCP tools — show the server.tool format
  return `\n\`🔧 ${cleanName}\`\n`;
}

function processTranscriptEvents(req: PendingRequest, newData: string): void {
  for (const line of newData.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    // Gate: skip all events until we see the queue-operation enqueue for
    // OUR message. This prevents cross-conversation contamination in the
    // shared transcript. Match by the user's message text appearing in the
    // enqueue content.
    if (!req.seenOwnEnqueue) {
      if (ev.type === 'queue-operation' && ev.operation === 'enqueue' && req.inboundText) {
        const content = (ev.content as string) || '';
        if (content.includes(req.inboundText.slice(0, 100))) {
          req.seenOwnEnqueue = true;
        }
      }
      continue;
    }

    // Stop processing at the NEXT enqueue (a different conversation's message).
    // This prevents picking up events from the next message in the queue.
    if (ev.type === 'queue-operation' && ev.operation === 'enqueue') {
      const content = (ev.content as string) || '';
      if (req.inboundText && !content.includes(req.inboundText.slice(0, 100))) {
        return;
      }
      continue;
    }

    // Send tool results as structured blocks so the frontend can render them.
    if (ev.type === 'user') {
      const content = (ev.message as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const text = extractToolResultText(block.content);
            if (text) {
              if (req.format === 'openai') {
                const summary = summarizeToolResult(text);
                if (summary) openaiChunk(req, summary);
              } else {
                sendContentBlockStart(req.res, req.contentIndex, { type: 'tool_result' as 'text', text: '' });
                sendContentBlockDelta(req.res, req.contentIndex, { type: 'tool_result_delta' as 'text_delta', text });
                sendContentBlockStop(req.res, req.contentIndex);
                req.contentIndex++;
              }
              updateStreamState(req, 'tool_use');
            }
          }
        }
      }
      continue;
    }

    const te = ev as TranscriptEvent;
    if (te.type !== 'assistant' || !Array.isArray(te.message?.content)) continue;

    const stopReason = te.message?.stop_reason as string | undefined;

    for (const block of te.message!.content!) {
      if (block.type === 'tool_use' && block.name && req.agentGroupId) {
        const toolName = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;

        // Inline file content from the agent's workspace
        if ((toolName === 'mcp__nanoclaw__send_file' || toolName === 'send_file') && input?.path) {
          inlineFileContent(req, input.path as string);
        }

        // Inline send_message text — the delivery poll no longer pushes
        // to SSE, so the message content must come from the transcript
        if ((toolName === 'mcp__nanoclaw__send_message' || toolName === 'send_message') && input?.text) {
          const msgText = stripMessageTags(input.text as string);
          if (msgText) {
            if (req.format === 'openai') {
              openaiChunk(req, msgText);
            } else {
              sendContentBlockStart(req.res, req.contentIndex, { type: 'text', text: '' });
              sendContentBlockDelta(req.res, req.contentIndex, { type: 'text_delta', text: msgText });
              sendContentBlockStop(req.res, req.contentIndex);
              req.contentIndex++;
            }
            updateStreamState(req, 'text');
          }
        }
      }

      if (req.format === 'openai') {
        if (block.type === 'thinking' && block.thinking) {
          openaiChunk(req, `<think>${block.thinking}</think>`);
          updateStreamState(req, 'thinking');
        } else if (block.type === 'tool_use' && block.name) {
          openaiChunk(req, formatToolLabel(block.name as string, block.input as Record<string, unknown> | undefined));
          updateStreamState(req, 'tool_use');
        } else if (block.type === 'text' && block.text) {
          const cleaned = stripMessageTags(block.text);
          for (let i = 0; i < cleaned.length; i += 80) {
            openaiChunk(req, cleaned.slice(i, i + 80));
          }
          updateStreamState(req, 'text');
        }
      } else {
        if (block.type === 'thinking' && block.thinking) {
          sendContentBlockStart(req.res, req.contentIndex, { type: 'thinking', thinking: '' });
          sendContentBlockDelta(req.res, req.contentIndex, { type: 'thinking_delta', thinking: block.thinking });
          sendContentBlockStop(req.res, req.contentIndex);
          req.contentIndex++;
          updateStreamState(req, 'thinking');
        } else if (block.type === 'tool_use' && block.name) {
          sendContentBlockStart(req.res, req.contentIndex, {
            type: 'tool_use',
            id: block.id || `tool_${req.contentIndex}`,
            name: block.name,
            input: {},
          });
          if (block.input) {
            sendContentBlockDelta(req.res, req.contentIndex, {
              type: 'input_json_delta',
              partial_json: JSON.stringify(block.input),
            });
          }
          sendContentBlockStop(req.res, req.contentIndex);
          req.contentIndex++;
          updateStreamState(req, 'tool_use');
        } else if (block.type === 'text' && block.text) {
          sendContentBlockStart(req.res, req.contentIndex, { type: 'text', text: '' });
          sendContentBlockDelta(req.res, req.contentIndex, { type: 'text_delta', text: stripMessageTags(block.text) });
          sendContentBlockStop(req.res, req.contentIndex);
          req.contentIndex++;
          updateStreamState(req, 'text');
        }
      }
    }

    // Definitive completion: the agent's final turn has stop_reason=end_turn
    // and we've already streamed content. No silence timer needed.
    if (stopReason === 'end_turn' && req.contentIndex > 0) {
      finalize(req, 'end_turn');
      return;
    }
  }
}

function finalize(req: PendingRequest, reason: string): void {
  if (req.finalized) return;
  req.finalized = true;
  if (req.pollHandle) clearTimeout(req.pollHandle);
  if (req.finalizeTimer) clearTimeout(req.finalizeTimer);

  try {
    if (!req.res.writableEnded) {
      if (req.format === 'openai') {
        req.res.write(
          `data: ${JSON.stringify({
            id: req.openaiMsgId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'bo',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
        req.res.write('data: [DONE]\n\n');
      } else {
        sendMessageDelta(req.res, 'end_turn');
        sendMessageStop(req.res);
      }
      req.res.end();
    }
  } catch {
    // Client may have already disconnected — safe to ignore
  }
  pending.delete(req.conversationId);
  log.info('SSE finalized', { reason, conversationId: req.conversationId });
}

function pollTranscript(reqId: string): void {
  const req = pending.get(reqId);
  if (!req || req.finalized) return;

  // Resolve this session's transcript. The shared transcript dir holds every
  // session's jsonl, so "latest file" heuristics pick the wrong one when
  // several sessions are active. The continuation mapping is authoritative;
  // it also tracks compaction rotations (new uuid → session_state updated).
  if (req.sessionId && req.agentGroupId) {
    const mapped = jsonlForSession(req.agentGroupId, req.sessionId);
    if (mapped && mapped !== req.jsonlPath) {
      req.jsonlPath = mapped;
      req.jsonlOffset = mapped === req.preRouteJsonlPath ? req.preRouteJsonlSize : 0;
    }
  }
  // Brand-new session whose continuation isn't persisted yet: tail whatever
  // jsonl appeared after we routed the message. The enqueue gate keeps us
  // from streaming another conversation's events if we guess wrong.
  if (!req.jsonlPath && req.agentGroupId) {
    const dir = findTranscriptDir(req.agentGroupId);
    req.jsonlPath = findLatestJsonl(dir, req.routeTimeMs);
    if (req.jsonlPath) req.jsonlOffset = 0;
  }

  if (req.jsonlPath && fs.existsSync(req.jsonlPath)) {
    try {
      const stat = fs.statSync(req.jsonlPath);
      if (stat.size > req.jsonlOffset) {
        req.lastActivityAt = Date.now();
        const len = stat.size - req.jsonlOffset;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(req.jsonlPath, 'r');
        try {
          fs.readSync(fd, buf, 0, len, req.jsonlOffset);
        } finally {
          fs.closeSync(fd);
        }
        req.jsonlOffset = stat.size;
        const raw = req.partialLine + buf.toString('utf-8');
        const lastNewline = raw.lastIndexOf('\n');
        if (lastNewline === -1) {
          req.partialLine = raw;
        } else {
          req.partialLine = raw.slice(lastNewline + 1);
          processTranscriptEvents(req, raw.slice(0, lastNewline + 1));
        }
        if (req.finalized) return;
      }
    } catch (err) {
      log.warn('web: poll read failed', { reqId, err });
    }
  }

  // Stale check — skip if already finalized (silence timer may have fired)
  // or if a question is pending (agent is intentionally blocked on the user).
  if (!req.finalized && !req.questionPending && Date.now() - req.lastActivityAt > STALE_MS) {
    if (req.contentIndex === 0) {
      if (req.format === 'openai') {
        openaiChunk(req, '(Bo timed out — no response received)');
      } else {
        sendContentBlockStart(req.res, req.contentIndex, { type: 'text', text: '' });
        sendContentBlockDelta(req.res, req.contentIndex, {
          type: 'text_delta',
          text: '(Bo timed out — no response received)',
        });
        sendContentBlockStop(req.res, req.contentIndex);
        req.contentIndex++;
      }
    }
    finalize(req, 'stale');
    return;
  }

  req.pollHandle = setTimeout(() => pollTranscript(reqId), POLL_MS);
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['WEB_CHANNEL_PORT']);
  const port = parseInt(env.WEB_CHANNEL_PORT || '3090', 10);

  let server: http.Server | null = null;
  let setup: ChannelSetup | null = null;

  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: 'web',
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      setup = config;

      server = http.createServer(async (req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === '/favicon.ico' || req.url === '/favicon.png') {
          const icoPath = path.resolve('bo-favicon.png');
          try {
            const icon = fs.readFileSync(icoPath);
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Length': icon.length.toString(),
              'Cache-Control': 'public, max-age=86400',
            });
            res.end(icon);
          } catch {
            res.writeHead(204);
            res.end();
          }
          return;
        }

        // Health check
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        // Live system prompt viewer
        if (req.method === 'GET' && req.url === '/system-prompt') {
          const content = resolveSystemPrompt();
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderSystemPromptPage(content));
          return;
        }

        // Raw markdown version
        if (req.method === 'GET' && req.url === '/system-prompt.md') {
          const content = resolveSystemPrompt();
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          res.end(content);
          return;
        }

        // Models endpoint — LibreChat may query available models
        if (req.method === 'GET' && req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [{ id: 'bo', object: 'model', created: Date.now(), owned_by: 'nanoclaw' }],
            }),
          );
          return;
        }

        // File download endpoint
        if (req.method === 'GET' && req.url?.startsWith('/files/')) {
          pruneExpiredFiles();
          const parts = req.url.slice('/files/'.length).split('/');
          const token = parts[0];
          if (!token || !/^[a-f0-9]{32}$/.test(token)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid token');
            return;
          }
          const entry = fileStore.get(token);
          if (!entry) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found or expired');
            return;
          }
          const origin = getFileBaseUrl();
          res.writeHead(200, {
            'Content-Type': entry.mime,
            'Content-Disposition': `attachment; filename="${entry.filename.replace(/["\\]/g, '_')}"`,
            'Content-Length': entry.data.length.toString(),
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': origin,
          });
          res.end(entry.data);
          return;
        }

        // Conversations list endpoint. Two sources, merged:
        //   1. Per-thread sessions (post-threading) — one session per thread,
        //      enumerated from the central DB.
        //   2. The legacy shared session (pre-threading) — all old threads
        //      live in one session's DBs, grouped by thread_id.
        if (req.method === 'GET' && req.url?.startsWith('/v1/conversations')) {
          try {
            interface ConvSummary {
              id: string;
              title: string;
              created_at: string;
              last_at: string;
              message_count: number;
            }
            const byThread = new Map<string, ConvSummary>();

            const USER_MSG_FILTER = `(content LIKE '%"sender":"BoUI"%' OR content LIKE '%"sender":"LibreChat"%')
                 AND content NOT LIKE '%"text":"<%'`;

            const titleFrom = (content: string | undefined): string => {
              if (!content) return '';
              try {
                const parsed = JSON.parse(content);
                return ((parsed.text || '') as string).replace(THREAD_CONTEXT_RE, '').trim().slice(0, 80);
              } catch {
                return '';
              }
            };

            // Source 1: per-thread sessions.
            const threadSessions = getDb()
              .prepare(
                `SELECT s.id, s.agent_group_id, s.thread_id
               FROM sessions s
               JOIN messaging_groups mg ON mg.id = s.messaging_group_id
               WHERE mg.channel_type = 'web' AND mg.platform_id = 'web:librechat'
                 AND s.thread_id IS NOT NULL
               ORDER BY s.created_at DESC LIMIT 60`,
              )
              .all() as Array<{ id: string; agent_group_id: string; thread_id: string }>;

            for (const ts of threadSessions) {
              try {
                const dbPath = path.join(SESSIONS_DIR, ts.agent_group_id, ts.id, 'inbound.db');
                if (!fs.existsSync(dbPath)) continue;
                const db = new Database(dbPath, { readonly: true, fileMustExist: true });
                const agg = db
                  .prepare(
                    `SELECT min(timestamp) as created_at, max(timestamp) as last_at, count(*) as message_count
                   FROM messages_in WHERE kind = 'chat' AND ${USER_MSG_FILTER}`,
                  )
                  .get() as { created_at: string | null; last_at: string | null; message_count: number };
                const firstRow = db
                  .prepare(
                    `SELECT content FROM messages_in
                   WHERE kind = 'chat' AND ${USER_MSG_FILTER}
                   ORDER BY seq ASC LIMIT 1`,
                  )
                  .get() as { content: string } | undefined;
                db.close();
                if (!agg.created_at || agg.message_count === 0) continue;
                const title = titleFrom(firstRow?.content);
                if (!title) continue;
                byThread.set(ts.thread_id, {
                  id: ts.thread_id.replace(/^web:/, ''),
                  title,
                  created_at: agg.created_at,
                  last_at: agg.last_at ?? agg.created_at,
                  message_count: agg.message_count,
                });
              } catch {
                /* skip unreadable session */
              }
            }

            // Source 2: legacy shared session, threads grouped in-place.
            const legacy = lookupSession('web', 'web:librechat', null);
            if (legacy && !legacy.threadScoped) {
              const dbPath = path.join(SESSIONS_DIR, legacy.agentGroupId, legacy.sessionId, 'inbound.db');
              if (fs.existsSync(dbPath)) {
                const inDb = new Database(dbPath, { readonly: true, fileMustExist: true });
                const rows = inDb
                  .prepare(
                    `SELECT thread_id,
                          min(timestamp) as created_at,
                          max(timestamp) as last_at,
                          count(*) as message_count
                   FROM messages_in
                   WHERE kind = 'chat' AND channel_type = 'web' AND thread_id IS NOT NULL
                     AND ${USER_MSG_FILTER}
                   GROUP BY thread_id
                   ORDER BY max(timestamp) DESC
                   LIMIT 50`,
                  )
                  .all() as Array<{ thread_id: string; created_at: string; last_at: string; message_count: number }>;

                for (const r of rows) {
                  const firstRow = inDb
                    .prepare(
                      `SELECT content FROM messages_in
                     WHERE thread_id = ? AND kind = 'chat' AND ${USER_MSG_FILTER}
                     ORDER BY seq ASC LIMIT 1`,
                    )
                    .get(r.thread_id) as { content: string } | undefined;
                  const title = titleFrom(firstRow?.content);
                  if (!title) continue;

                  const existing = byThread.get(r.thread_id);
                  if (existing) {
                    // Thread spans both eras: legacy holds the true opening.
                    existing.title = title;
                    existing.created_at = r.created_at;
                    existing.message_count += r.message_count;
                  } else {
                    byThread.set(r.thread_id, {
                      id: r.thread_id.replace(/^web:/, ''),
                      title,
                      created_at: r.created_at,
                      last_at: r.last_at,
                      message_count: r.message_count,
                    });
                  }
                }
                inDb.close();
              }
            }

            const toUtcMs = (ts: string) => new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime();
            const all = [...byThread.values()].sort((a, b) => toUtcMs(b.last_at) - toUtcMs(a.last_at));

            const isAutomated = (title: string) =>
              /^(Weekly |Slack wiki|Check for new|Daily |Morning |Evening |Hourly )/i.test(title) ||
              title.startsWith('<');

            const conversations = all.filter((c) => !isAutomated(c.title));
            const scheduled = all.filter((c) => isAutomated(c.title));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ conversations, scheduled }));
          } catch (err) {
            log.error('web: conversations failed', { err });
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to load conversations' }));
          }
          return;
        }

        // Chat history endpoint (filtered by thread). Reads the thread's own
        // session AND the legacy shared session — a thread that spans the
        // per-thread migration has its early messages in the legacy DBs.
        if (req.method === 'GET' && req.url?.startsWith('/v1/history')) {
          try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '50', 10), 200);
            const threadParam = urlObj.searchParams.get('thread') || 'conv-default';
            const threadId = `web:${threadParam}`;

            const threadSess = lookupSession('web', 'web:librechat', threadId);
            const legacySess = lookupSession('web', 'web:librechat', null);
            const sources: Array<{ sessionId: string; agentGroupId: string }> = [];
            if (threadSess?.threadScoped) sources.push(threadSess);
            if (legacySess && !sources.some((s) => s.sessionId === legacySess.sessionId)) {
              sources.push(legacySess);
            }

            const messages: Array<{
              id: string;
              role: 'user' | 'assistant';
              timestamp: string;
              content: string;
            }> = [];

            for (const src of sources) {
              const sessDir = path.join(SESSIONS_DIR, src.agentGroupId, src.sessionId);

              let inRows: Array<{ id: string; timestamp: string; content: string }> = [];
              let outRows: Array<{ id: string; in_reply_to: string; timestamp: string; content: string }> = [];

              try {
                const inDb = new Database(path.join(sessDir, 'inbound.db'), { readonly: true, fileMustExist: true });
                inRows = inDb
                  .prepare(
                    `SELECT id, timestamp, content FROM messages_in
                   WHERE kind = 'chat' AND channel_type = 'web' AND thread_id = ?
                   ORDER BY seq DESC LIMIT ?`,
                  )
                  .all(threadId, limit) as typeof inRows;
                inDb.close();
              } catch (e) {
                log.warn('web: history inbound read failed', { error: String(e) });
              }

              try {
                const outDb = new Database(path.join(sessDir, 'outbound.db'), { readonly: true, fileMustExist: true });
                outRows = outDb
                  .prepare(
                    `SELECT id, in_reply_to, timestamp, content FROM messages_out
                   WHERE kind = 'chat' AND in_reply_to IS NOT NULL AND thread_id = ?
                   ORDER BY seq DESC LIMIT ?`,
                  )
                  .all(threadId, limit) as typeof outRows;
                outDb.close();
              } catch (e) {
                log.warn('web: history outbound read failed', { error: String(e) });
              }

              const inIds = new Set(inRows.map((r) => r.id));
              const filteredOutRows = outRows.filter((r) => inIds.has(r.in_reply_to));

              for (const row of inRows) {
                try {
                  const parsed = JSON.parse(row.content);
                  // Strip legacy injected thread-context — agent-facing, not UI.
                  const text = ((parsed.text || '') as string).replace(THREAD_CONTEXT_RE, '');
                  messages.push({ id: row.id, role: 'user', timestamp: row.timestamp, content: text });
                } catch {
                  /* skip */
                }
              }

              for (const row of filteredOutRows) {
                try {
                  const parsed = JSON.parse(row.content);
                  messages.push({
                    id: row.id,
                    role: 'assistant',
                    timestamp: row.timestamp,
                    content: parsed.text || '',
                  });
                } catch {
                  /* skip */
                }
              }
            }

            const toUtc = (ts: string) => new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime();
            messages.sort((a, b) => toUtc(a.timestamp) - toUtc(b.timestamp));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ messages }));
          } catch (err) {
            log.error('web: history failed', { err });
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to load history' }));
          }
          return;
        }

        // Answer a pending ask_user_question (BoUI option-button click).
        // Routes through the same onAction path Slack buttons use.
        if (req.method === 'POST' && req.url === '/v1/answer') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          let body: { questionId?: string; value?: string; thread?: string };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }
          if (!body.questionId || typeof body.value !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'questionId and value are required' }));
            return;
          }
          try {
            // Let the pending SSE resume finalizing once the agent replies.
            if (body.thread) {
              const req2 = pending.get(`web:${body.thread}`);
              if (req2) {
                req2.questionPending = false;
                req2.lastActivityAt = Date.now();
              }
            }
            setup!.onAction(body.questionId, body.value, 'web:joel');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            log.error('web: answer failed', { err });
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to record answer' }));
          }
          return;
        }

        // Anthropic messages endpoint
        if (req.method === 'POST' && req.url === '/v1/messages') {
          await handleMessages(req, res, 'anthropic');
          return;
        }

        // OpenAI chat completions endpoint (for custom endpoint config)
        if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
          log.info('web: chat/completions request received', {
            url: req.url,
            headers: { host: req.headers.host, ua: req.headers['user-agent']?.slice(0, 50) },
          });
          await handleMessages(req, res, 'openai');
          return;
        }

        log.info('web: unhandled request', { method: req.method, url: req.url });
        res.writeHead(404);
        res.end('Not found');
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, '0.0.0.0', () => {
          log.info('Web channel listening', { port });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const [, req] of pending) {
        if (!req.finalized) {
          req.finalized = true;
          if (req.pollHandle) clearTimeout(req.pollHandle);
          if (req.finalizeTimer) clearTimeout(req.finalizeTimer);
          try {
            req.res.end();
          } catch {
            /* */
          }
        }
      }
      pending.clear();
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown> | undefined;

      // ask_user_question: surface the choices to the open SSE for this thread
      // as a structured event BoUI renders as clickable buttons. The agent is
      // now blocked polling for the answer — mark the request questionPending
      // so we don't finalize the stream while it waits.
      if (content?.type === 'ask_question' && threadId) {
        const req = pending.get(threadId);
        if (req && !req.finalized) {
          req.questionPending = true;
          if (req.finalizeTimer) {
            clearTimeout(req.finalizeTimer);
            req.finalizeTimer = null;
          }
          try {
            req.res.write(
              `event: ask_question\ndata: ${JSON.stringify({
                type: 'ask_question',
                questionId: content.questionId,
                title: content.title,
                question: content.question,
                options: content.options,
              })}\n\n`,
            );
          } catch {
            /* client gone */
          }
        }
        return `web-q-${content.questionId}`;
      }

      const files = message.files;
      const hasFiles = files && files.length > 0;

      // When files are present the transcript already streamed the agent's
      // text response — suppress the send_file text to avoid duplication.
      const text = (typeof content?.text === 'string' ? content.text : '') as string;
      const cleanedText = hasFiles ? '' : text ? stripMessageTags(text) : '';

      const fileParts: string[] = [];
      if (hasFiles) {
        pruneExpiredFiles();
        const baseUrl = getFileBaseUrl();
        for (const f of files!) {
          const ext = f.filename.split('.').pop()?.toLowerCase() ?? '';
          const mime = extToMime(ext);
          const token = storeFile(f.filename, f.data);
          const url = `${baseUrl}/files/${token}/${encodeURIComponent(f.filename)}`;
          if (mime.startsWith('image/') && f.data.length <= 256 * 1024) {
            const b64 = f.data.toString('base64');
            fileParts.push(`![${f.filename}](data:${mime};base64,${b64})`);
          } else if (mime.startsWith('image/')) {
            fileParts.push(`[![${f.filename}](${url})](${url})`);
          } else {
            fileParts.push(`[📎 ${f.filename}](${url})`);
            if (TEXT_EXTENSIONS.has(ext) && f.data.length < 32_768) {
              const textContent = f.data.toString('utf-8');
              const lang = ext === 'md' ? 'markdown' : ext;
              fileParts.push(`\`\`\`${lang}\n${textContent}\n\`\`\``);
            }
          }
        }
      }

      const fullContent = [cleanedText, ...fileParts].filter(Boolean).join('\n\n');

      // Webhook fallback for scheduled tasks with no SSE connection.
      // SSE content is handled by the transcript streaming path (which
      // inlines file content when it sees send_file tool_use events).
      if (fullContent && process.env.OWUI_WEBHOOK_URL) {
        try {
          const whBody = JSON.stringify({ content: fullContent });
          const whUrl = new URL(process.env.OWUI_WEBHOOK_URL);
          const whReq = http.request(
            {
              hostname: whUrl.hostname,
              port: whUrl.port || 3000,
              path: whUrl.pathname,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(whBody) },
            },
            (whRes) => {
              if (whRes.statusCode && whRes.statusCode >= 400) {
                log.warn('Webhook delivery failed', { status: whRes.statusCode });
              }
            },
          );
          whReq.on('error', (e) => {
            log.warn('Webhook request error', { error: String(e) });
          });
          try {
            whReq.write(whBody);
            whReq.end();
          } catch (e) {
            log.warn('Webhook write error', { error: String(e) });
          }
        } catch (e) {
          log.warn('Webhook setup error', { error: String(e) });
        }
      } else if (fullContent && hasFiles) {
        // No SSE connection and no webhook — file content has nowhere to go.
        // This happens during scheduled tasks when OWUI_WEBHOOK_URL is not set.
        log.warn('File delivered but no recipient', {
          threadId,
          hasFiles,
          contentLen: fullContent.length,
        });
      }
      return `web-${Date.now()}`;
    },
  };

  async function handleMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    format: OutputFormat,
  ): Promise<void> {
    // Parse body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: {
      model?: string;
      messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      stream?: boolean;
      max_tokens?: number;
      metadata?: { conversation_id?: string };
    };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Extract the latest user message
    const userMessages = (body.messages ?? []).filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No user message found' }));
      return;
    }

    let text: string;
    if (typeof lastUserMsg.content === 'string') {
      text = lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.content)) {
      text = lastUserMsg.content
        .filter(
          (b): b is { type: string; text: string } =>
            b != null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string',
        )
        .map((b) => b.text)
        .join('\n');
    } else {
      text = String(lastUserMsg.content);
    }

    // All BoUI conversations route through the same messaging group.
    // NanoClaw session separation happens via threadId (the BoUI conversation ID).
    const conversationId =
      body.metadata?.conversation_id || ((body as Record<string, unknown>).chat_id as string) || `conv-${Date.now()}`;
    const platformId = 'web:librechat';

    const threadId = `web:${conversationId}`;

    // Look up the thread's session before routing so we can capture the
    // transcript offset BEFORE the message is routed. The enqueue gate in
    // processTranscriptEvents skips events until it finds our message —
    // but to find it, the offset must be before our enqueue. Only a
    // thread-scoped session counts: for a new thread the router will
    // create one during routing.
    const preRoute = lookupSession('web', platformId, threadId);
    const preRouteSession = preRoute?.threadScoped ? preRoute : null;
    let preRouteJsonlPath: string | null = null;
    let preRouteJsonlSize = 0;
    if (preRouteSession) {
      preRouteJsonlPath = jsonlForSession(preRouteSession.agentGroupId, preRouteSession.sessionId);
      if (preRouteJsonlPath) {
        try {
          preRouteJsonlSize = fs.statSync(preRouteJsonlPath).size;
        } catch {
          /* */
        }
      }
    }
    const routeTimeMs = Date.now();

    // Route through NanoClaw
    const msgId = `web-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      await setup!.onInbound(platformId, threadId, {
        id: msgId,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text,
          sender: 'BoUI',
          senderId: 'web:joel',
        },
      });
    } catch (err) {
      log.error('web: onInbound failed', { err });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Routing failed' }));
      return;
    }

    // Set up SSE streaming
    const isStream = body.stream !== false;
    if (!isStream) {
      // Non-streaming not supported yet — tell the client to use streaming
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only streaming mode is supported. Set stream: true.' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
    const openaiChatId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

    if (format === 'anthropic') {
      sendMessageStart(res, messageId, 'bo');
    }

    // Look up the thread's session (may take a moment for router to create
    // it). Only accept a thread-scoped match — the legacy shared session is
    // a read-only history source, never the streaming target.
    const resolveSession = (): { sessionId: string; agentGroupId: string } | null => {
      const s = lookupSession('web', platformId, threadId);
      return s?.threadScoped ? s : null;
    };

    // Create pending request entry — key by threadId for uniqueness.
    // If a previous request with the same key exists, finalize it first
    // to prevent timer leaks and map corruption.
    const reqKey = threadId;
    const existing = pending.get(reqKey);
    if (existing && !existing.finalized) {
      finalize(existing, 'superseded');
    }
    const pendReq: PendingRequest = {
      res,
      conversationId: reqKey,
      sessionId: preRouteSession?.sessionId ?? null,
      agentGroupId: preRouteSession?.agentGroupId ?? null,
      jsonlPath: null,
      jsonlOffset: 0,
      routeTimeMs,
      preRouteJsonlPath,
      preRouteJsonlSize,
      pollHandle: null,
      lastActivityAt: Date.now(),
      finalized: false,
      finalizeTimer: null,
      lastStreamedType: null,
      partialLine: '',
      inboundMsgId: msgId,
      inboundText: text,
      seenOwnEnqueue: false,
      messageIndex: 0,
      contentIndex: 0,
      format,
      openaiMsgId: openaiChatId,
      questionPending: false,
    };
    pending.set(reqKey, pendReq);

    // Wait briefly for session creation, then start polling. The jsonl is
    // resolved inside pollTranscript via the session's continuation mapping.
    const tryResolve = (attempts: number) => {
      const sess = resolveSession();
      if (sess) {
        pendReq.sessionId = sess.sessionId;
        pendReq.agentGroupId = sess.agentGroupId;
        pollTranscript(reqKey);
      } else if (attempts < 60) {
        setTimeout(() => tryResolve(attempts + 1), 500);
      } else {
        log.warn('web: session not found after 30s', { platformId, threadId });
        const errMsg = '(Could not resolve session — is the agent group wired?)';
        if (format === 'openai') {
          openaiChunk(pendReq, errMsg);
        } else {
          sendContentBlockStart(res, 0, { type: 'text', text: '' });
          sendContentBlockDelta(res, 0, { type: 'text_delta', text: errMsg });
          sendContentBlockStop(res, 0);
        }
        finalize(pendReq, 'no_session');
      }
    };
    tryResolve(0);

    // Handle client disconnect
    req.on('close', () => {
      if (!pendReq.finalized) {
        pendReq.finalized = true;
        if (pendReq.pollHandle) clearTimeout(pendReq.pollHandle);
        if (pendReq.finalizeTimer) clearTimeout(pendReq.finalizeTimer);
        pending.delete(reqKey);
      }
    });
  }

  return adapter;
}

registerChannelAdapter('web', { factory: createAdapter });
