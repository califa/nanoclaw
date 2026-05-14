/**
 * bo-token-usage — host-side aggregator.
 *
 * Container-side capture lives in container/agent-runner/src/providers/
 * claude.ts: on every SDK `result`, append a JSON record to
 * /workspace/usage.jsonl (which on the host is
 * data/v2-sessions/<group>/<session>/usage.jsonl).
 *
 * This plugin:
 *   1. Periodically tails every session's usage.jsonl.
 *   2. Looks up the session in the central DB to get agent_group_id and
 *      messaging_group_id (→ group_folder + chat_jid).
 *   3. Inserts a row into the central `token_usage` table with both v2-style
 *      columns (session_id, agent_group_id, model) AND v1-style columns
 *      (timestamp, group_folder, chat_jid, source, total_cost_usd,
 *      num_turns, duration_ms, duration_api_ms) so the user's dashboard at
 *      :3002 keeps working with no SQL changes.
 *   4. Updates `session_context` with the latest input_tokens snapshot
 *      (= current context window size) so the dashboard can show context
 *      pressure per active session.
 *
 * Per-session offset tracking lives in `.usage-ingested-offset` next to
 * the JSONL so restarts don't re-ingest.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/connection.js';
import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions');
const POLL_INTERVAL_MS = 60_000;

interface UsageRecord {
  ts: string;
  sdk_session_id?: string;
  model?: string;
  num_turns?: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
}

let pollTimer: NodeJS.Timeout | null = null;

function listSessionDirs(): Array<{ agentGroupId: string; sessionId: string; sessionDir: string }> {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const result: Array<{ agentGroupId: string; sessionId: string; sessionDir: string }> = [];
  for (const groupDir of fs.readdirSync(SESSIONS_DIR)) {
    const groupPath = path.join(SESSIONS_DIR, groupDir);
    if (!fs.statSync(groupPath).isDirectory()) continue;
    for (const sessId of fs.readdirSync(groupPath)) {
      const sessPath = path.join(groupPath, sessId);
      if (!fs.statSync(sessPath).isDirectory()) continue;
      result.push({ agentGroupId: groupDir, sessionId: sessId, sessionDir: sessPath });
    }
  }
  return result;
}

interface SessionMeta {
  agent_group_id: string;
  group_folder: string;
  chat_jid: string | null;
}

const metaCache = new Map<string, SessionMeta>();

function getSessionMeta(sessionId: string): SessionMeta | null {
  if (metaCache.has(sessionId)) return metaCache.get(sessionId)!;
  const row = getDb()
    .prepare(
      `SELECT s.agent_group_id, ag.folder AS group_folder,
              mg.channel_type, mg.platform_id
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | { agent_group_id: string; group_folder: string; channel_type: string | null; platform_id: string | null }
    | undefined;
  if (!row) return null;
  const meta: SessionMeta = {
    agent_group_id: row.agent_group_id,
    group_folder: row.group_folder,
    chat_jid: row.channel_type && row.platform_id ? `${row.channel_type}:${row.platform_id}` : null,
  };
  metaCache.set(sessionId, meta);
  return meta;
}

function readOffset(stateFile: string): number {
  if (!fs.existsSync(stateFile)) return 0;
  try {
    return parseInt(fs.readFileSync(stateFile, 'utf-8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeOffset(stateFile: string, offset: number): void {
  fs.writeFileSync(stateFile, String(offset));
}

async function ingestSession(s: { agentGroupId: string; sessionId: string; sessionDir: string }): Promise<number> {
  const usageFile = path.join(s.sessionDir, 'usage.jsonl');
  if (!fs.existsSync(usageFile)) return 0;

  const stateFile = path.join(s.sessionDir, '.usage-ingested-offset');
  const offset = readOffset(stateFile);
  const stat = fs.statSync(usageFile);
  if (stat.size <= offset) return 0;

  const fd = fs.openSync(usageFile, 'r');
  try {
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const lines = buf
      .toString('utf-8')
      .split('\n')
      .filter((l) => l.trim());

    const meta = getSessionMeta(s.sessionId);

    const insert = getDb().prepare(
      `INSERT INTO token_usage (
         session_id, agent_group_id, model,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, ts,
         timestamp, group_folder, chat_jid, source,
         total_cost_usd, num_turns, duration_ms, duration_api_ms
       ) VALUES (
         @session_id, @agent_group_id, @model,
         @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens, @ts,
         @timestamp, @group_folder, @chat_jid, @source,
         @total_cost_usd, @num_turns, @duration_ms, @duration_api_ms
       )`,
    );

    const upsertContext = getDb().prepare(
      `INSERT INTO session_context (
         session_id, agent_group_id, group_folder, input_tokens,
         cache_read_tokens, cache_creation_tokens, model, updated_at
       ) VALUES (
         @session_id, @agent_group_id, @group_folder, @input_tokens,
         @cache_read_tokens, @cache_creation_tokens, @model, @updated_at
       )
       ON CONFLICT(session_id) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         model = excluded.model,
         updated_at = excluded.updated_at`,
    );

    let inserted = 0;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as UsageRecord;
        insert.run({
          session_id: s.sessionId,
          agent_group_id: meta?.agent_group_id ?? s.agentGroupId,
          model: rec.model ?? 'unknown',
          input_tokens: rec.input_tokens,
          output_tokens: rec.output_tokens,
          cache_creation_tokens: rec.cache_creation_tokens,
          cache_read_tokens: rec.cache_read_tokens,
          ts: rec.ts,
          timestamp: rec.ts,
          group_folder: meta?.group_folder ?? s.agentGroupId,
          chat_jid: meta?.chat_jid ?? null,
          source: `agent:${s.sessionId.slice(0, 12)}`,
          total_cost_usd: rec.total_cost_usd ?? 0,
          num_turns: rec.num_turns ?? 0,
          duration_ms: rec.duration_ms ?? 0,
          duration_api_ms: rec.duration_api_ms ?? 0,
        });
        upsertContext.run({
          session_id: s.sessionId,
          agent_group_id: meta?.agent_group_id ?? s.agentGroupId,
          group_folder: meta?.group_folder ?? s.agentGroupId,
          input_tokens: rec.input_tokens,
          cache_read_tokens: rec.cache_read_tokens,
          cache_creation_tokens: rec.cache_creation_tokens,
          model: rec.model ?? null,
          updated_at: rec.ts,
        });
        inserted++;
      } catch (err) {
        log.warn('bo-token-usage: skipping malformed line', { line: line.slice(0, 80), err });
      }
    }

    writeOffset(stateFile, stat.size);
    return inserted;
  } finally {
    fs.closeSync(fd);
  }
}

async function pollOnce(): Promise<void> {
  const sessions = listSessionDirs();
  let total = 0;
  for (const s of sessions) {
    try {
      total += await ingestSession(s);
    } catch (err) {
      log.warn('bo-token-usage: ingest failed', { sessionDir: s.sessionDir, err });
    }
  }
  if (total > 0) {
    log.info('bo-token-usage: ingested usage records', { count: total });
  }
}

export default async function init(): Promise<void> {
  void pollOnce().catch((err) => log.error('bo-token-usage: initial poll failed', { err }));
  pollTimer = setInterval(() => {
    void pollOnce().catch((err) => log.error('bo-token-usage: poll failed', { err }));
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  log.info('bo-token-usage: ingester started', { pollIntervalMs: POLL_INTERVAL_MS, sessionsDir: SESSIONS_DIR });
}
