/**
 * bo-token-usage — host-side aggregator.
 *
 * The container-side capture lives in container/agent-runner/src/providers/
 * claude.ts: on every SDK `result` message, it appends a JSON record to
 * /workspace/usage.jsonl (which on the host is data/v2-sessions/<group>/<session>/usage.jsonl).
 *
 * This plugin runs a periodic tail of every session's usage.jsonl, ingests
 * new lines into the central data/v2.db.token_usage table, and tracks the
 * read offset in a small state file per session so we don't re-ingest.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/connection.js';
import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions');
const POLL_INTERVAL_MS = 60_000; // 60s — token usage isn't latency-critical

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

    const insert = getDb().prepare(
      `INSERT INTO token_usage (session_id, agent_group_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, ts)
       VALUES (@session_id, @agent_group_id, @model, @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens, @ts)`,
    );

    let inserted = 0;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as UsageRecord;
        insert.run({
          session_id: s.sessionId,
          agent_group_id: s.agentGroupId,
          model: rec.model ?? 'unknown',
          input_tokens: rec.input_tokens,
          output_tokens: rec.output_tokens,
          cache_creation_tokens: rec.cache_creation_tokens,
          cache_read_tokens: rec.cache_read_tokens,
          ts: rec.ts,
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
  // Run once at startup to catch up on any pre-existing usage files.
  void pollOnce().catch((err) => log.error('bo-token-usage: initial poll failed', { err }));

  // Then poll on an interval.
  pollTimer = setInterval(() => {
    void pollOnce().catch((err) => log.error('bo-token-usage: poll failed', { err }));
  }, POLL_INTERVAL_MS);
  // Don't keep the event loop alive purely for the poll timer.
  pollTimer.unref?.();

  log.info('bo-token-usage: ingester started', { pollIntervalMs: POLL_INTERVAL_MS, sessionsDir: SESSIONS_DIR });
}
