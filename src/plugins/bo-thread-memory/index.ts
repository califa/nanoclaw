/**
 * bo-thread-memory — automatic memory extraction from per-thread sessions.
 *
 * With per-thread web sessions, each BoUI conversation is isolated: perfect
 * thread context, but nothing carries over between threads. This plugin is
 * the shared layer: when a thread session goes idle, a model pass reads the
 * conversation, extracts durable memories (facts, decisions, preferences,
 * corrections) plus a short summary, and writes them to the group workspace
 * at memory/threads.md — mounted into every session's container, so every
 * future thread can consult it.
 *
 * Idle = no new messages for IDLE_MS. Threads are re-summarized when new
 * messages arrive after a summarization (entry is replaced in place, keyed
 * by thread-id markers). Model verdict "SKIP" is recorded so trivial threads
 * don't re-trigger calls.
 */
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { getDb } from '../../db/connection.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const GROUP_DIR = path.resolve('groups/web_main');
const MEMORY_FILE = path.join(GROUP_DIR, 'memory', 'threads.md');
const SESSIONS_DIR = path.resolve('data/v2-sessions');

// Haiku: extraction is a cheap structured task, and the big-model tiers of
// the subscription quota are often exhausted by Bo's own sessions (verified
// 2026-07-01: sonnet 429'd while haiku returned 200 on the same token).
const MODEL = 'claude-haiku-4-5-20251001';
const SCAN_INTERVAL = 10 * 60 * 1000;
const STARTUP_DELAY = 3 * 60 * 1000;
const IDLE_MS = 20 * 60 * 1000;
const MAX_PER_PASS = 3;
const MEMORY_FILE_CAP = 150_000;

interface SessionRow {
  id: string;
  agent_group_id: string;
  thread_id: string;
}

function ensureTable(): void {
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS bo_thread_memory (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        summarized_at TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        wrote_memory INTEGER NOT NULL
      );
    `);
  } catch (err) {
    log.warn('bo-thread-memory: ensureTable failed', { err });
  }
}

function getClient(): Anthropic | null {
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  if (env.ANTHROPIC_API_KEY) return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const oauthCache = path.join(process.env.HOME ?? '/Users/joel', '.config', 'nanoclaw', 'claude-oauth.json');
  try {
    const raw = JSON.parse(fs.readFileSync(oauthCache, 'utf8'));
    const token = raw?.claudeAiOauth?.accessToken;
    if (token) return new Anthropic({ authToken: token });
  } catch {
    /* */
  }
  return null;
}

const toUtcMs = (ts: string) => new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime();

interface ThreadTranscript {
  turns: Array<{ who: 'Joel' | 'Bo'; ts: string; text: string }>;
  messageCount: number;
  lastActivityMs: number;
}

function readThread(sess: SessionRow): ThreadTranscript | null {
  const dir = path.join(SESSIONS_DIR, sess.agent_group_id, sess.id);
  const turns: ThreadTranscript['turns'] = [];
  let lastActivityMs = 0;

  try {
    const inDb = new Database(path.join(dir, 'inbound.db'), { readonly: true, fileMustExist: true });
    const inRows = inDb
      .prepare(`SELECT timestamp, content FROM messages_in WHERE kind = 'chat' ORDER BY seq ASC LIMIT 100`)
      .all() as Array<{ timestamp: string; content: string }>;
    inDb.close();
    for (const r of inRows) {
      try {
        const text = ((JSON.parse(r.content).text || '') as string).trim();
        if (!text) continue;
        turns.push({ who: 'Joel', ts: r.timestamp, text });
        lastActivityMs = Math.max(lastActivityMs, toUtcMs(r.timestamp));
      } catch {
        /* */
      }
    }
  } catch {
    return null;
  }

  try {
    const outDb = new Database(path.join(dir, 'outbound.db'), { readonly: true, fileMustExist: true });
    const outRows = outDb
      .prepare(`SELECT timestamp, content FROM messages_out WHERE kind = 'chat' ORDER BY seq ASC LIMIT 100`)
      .all() as Array<{ timestamp: string; content: string }>;
    outDb.close();
    for (const r of outRows) {
      try {
        const text = ((JSON.parse(r.content).text || '') as string).trim();
        if (!text) continue;
        turns.push({ who: 'Bo', ts: r.timestamp, text });
        lastActivityMs = Math.max(lastActivityMs, toUtcMs(r.timestamp));
      } catch {
        /* */
      }
    }
  } catch {
    /* outbound may not exist yet */
  }

  if (turns.length === 0) return null;
  turns.sort((a, b) => toUtcMs(a.ts) - toUtcMs(b.ts));
  return { turns, messageCount: turns.length, lastActivityMs };
}

async function summarize(client: Anthropic, threadId: string, t: ThreadTranscript): Promise<{ wrote: boolean }> {
  const corpus = t.turns
    .map((turn) => `[${turn.who}]: ${turn.text.slice(0, 1500)}`)
    .join('\n\n')
    .slice(-24_000);

  const prompt = `You maintain long-term memory for Bo, Joel's personal AI assistant. Conversations happen in isolated threads; anything worth remembering must be extracted here or it is lost to future threads.

Below is one complete thread. Extract only durable information:
- facts about Joel, people he works with, projects, or systems
- decisions made or preferences Joel expressed
- open commitments or follow-ups
- corrections Joel made to Bo's behavior

Ignore pleasantries, one-off trivia answers, and anything only meaningful inside this thread.

Output exactly this format:
SUMMARY: <1-2 sentence summary of the thread>
MEMORIES:
- <durable memory>
- <durable memory>

If nothing is worth remembering long-term, output exactly: SKIP

# THREAD
${corpus}`;

  const result = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = result.content.find((b) => b.type === 'text');
  const text = block && block.type === 'text' ? block.text.trim() : '';
  if (!text || text === 'SKIP' || text.startsWith('SKIP')) return { wrote: false };

  const title = t.turns.find((turn) => turn.who === 'Joel')?.text.slice(0, 70) ?? threadId;
  const date = new Date().toISOString().slice(0, 10);
  const entry = [
    `<!-- thread:${threadId} -->`,
    `## ${title.replace(/\n/g, ' ')} — ${date}`,
    text,
    `<!-- /thread:${threadId} -->`,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  let existing = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf-8') : '';

  // Replace this thread's prior entry if present (re-summarization).
  const entryRe = new RegExp(
    `<!-- thread:${threadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -->[\\s\\S]*?<!-- /thread:${threadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -->\\n?`,
  );
  if (entryRe.test(existing)) {
    existing = existing.replace(entryRe, '');
  }

  let updated = existing.trimEnd() + (existing.trim() ? '\n\n' : '') + entry;

  // Cap: drop oldest entries from the top until under the limit.
  while (updated.length > MEMORY_FILE_CAP) {
    const firstEnd = updated.indexOf('<!-- /thread:');
    if (firstEnd === -1) break;
    const cut = updated.indexOf('\n', updated.indexOf('-->', firstEnd)) + 1;
    if (cut <= 0) break;
    updated = updated.slice(cut).trimStart();
  }

  fs.writeFileSync(MEMORY_FILE, updated + (updated.endsWith('\n') ? '' : '\n'));
  return { wrote: true };
}

async function scan(): Promise<void> {
  ensureTable();
  const client = getClient();
  if (!client) {
    log.warn('bo-thread-memory: no creds — skipping pass');
    return;
  }

  let sessions: SessionRow[];
  try {
    sessions = getDb()
      .prepare(
        `SELECT s.id, s.agent_group_id, s.thread_id
       FROM sessions s
       JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       WHERE mg.channel_type = 'web' AND s.thread_id IS NOT NULL
       ORDER BY s.created_at DESC LIMIT 100`,
      )
      .all() as SessionRow[];
  } catch (err) {
    log.warn('bo-thread-memory: session scan failed', { err });
    return;
  }

  let processed = 0;
  for (const sess of sessions) {
    if (processed >= MAX_PER_PASS) break;

    const prior = getDb().prepare(`SELECT message_count FROM bo_thread_memory WHERE session_id = ?`).get(sess.id) as
      | { message_count: number }
      | undefined;

    const t = readThread(sess);
    if (!t) continue;
    if (Date.now() - t.lastActivityMs < IDLE_MS) continue; // still active
    if (prior && prior.message_count >= t.messageCount) continue; // already summarized, nothing new
    if (t.turns.filter((x) => x.who === 'Joel').length === 0) continue;
    if (t.turns.reduce((n, x) => n + x.text.length, 0) < 200) continue;

    try {
      const { wrote } = await summarize(client, sess.thread_id, t);
      getDb()
        .prepare(
          `INSERT INTO bo_thread_memory (session_id, thread_id, summarized_at, message_count, wrote_memory)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           summarized_at = excluded.summarized_at,
           message_count = excluded.message_count,
           wrote_memory = excluded.wrote_memory`,
        )
        .run(sess.id, sess.thread_id, new Date().toISOString(), t.messageCount, wrote ? 1 : 0);
      processed++;
      log.info('bo-thread-memory: thread processed', { threadId: sess.thread_id, wrote, turns: t.messageCount });
    } catch (err) {
      log.warn('bo-thread-memory: summarize failed', { threadId: sess.thread_id, err });
    }
  }

  if (processed > 0) {
    log.info('bo-thread-memory: pass complete', { candidates: sessions.length, processed });
  } else {
    log.debug('bo-thread-memory: pass complete, nothing eligible', { candidates: sessions.length });
  }
}

export default async function init(): Promise<void> {
  ensureTable();
  setTimeout(() => void scan(), STARTUP_DELAY).unref?.();
  setInterval(() => void scan(), SCAN_INTERVAL).unref?.();
  log.info('bo-thread-memory: scheduled thread-memory extraction', {
    memoryFile: MEMORY_FILE,
    intervalMin: SCAN_INTERVAL / 60000,
  });
}
