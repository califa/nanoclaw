/**
 * bo-scheduler-tags — handlers for <retry>, <healed>, <no-fix> tags.
 *
 * v2 stores scheduled-task state in per-session `messages_in` rows (not a
 * global scheduled_tasks table like v1). To act on a tag, we find the task
 * row in the session's inbound.db (most recent pending/processing kind='task')
 * and update its process_after / status.
 *
 * Retry counter survives across messages_in rows via `bo_task_retry` keyed
 * by series_id (added on first use).
 *
 * Backoff: 15min, 30min, then healer prompt with 1min delay.
 */
import type Database from 'better-sqlite3';
import { registerSignalHandler } from '../../extension-points.js';
import { openInboundDb } from '../../session-manager.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';

const RETRY_DELAYS_MIN = [15, 30];
const HEALER_PROMPT_PREFIX = 'You are a self-healing agent. ';

interface MessageInRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  content: string;
}

function ensureRetryTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bo_task_retry (
      series_id TEXT PRIMARY KEY,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_failure_reason TEXT,
      paused_reason TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function bumpRetry(db: Database.Database, seriesId: string, reason: string): number {
  const now = new Date().toISOString();
  const before = db.prepare('SELECT retry_count FROM bo_task_retry WHERE series_id = ?').get(seriesId) as
    | { retry_count: number }
    | undefined;
  const next = (before?.retry_count ?? 0) + 1;
  db.prepare(
    `INSERT INTO bo_task_retry (series_id, retry_count, last_failure_reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(series_id) DO UPDATE SET
       retry_count = excluded.retry_count,
       last_failure_reason = excluded.last_failure_reason,
       updated_at = excluded.updated_at`,
  ).run(seriesId, next, reason, now);
  return next;
}

function resetRetry(db: Database.Database, seriesId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bo_task_retry (series_id, retry_count, updated_at)
     VALUES (?, 0, ?)
     ON CONFLICT(series_id) DO UPDATE SET
       retry_count = 0,
       last_failure_reason = NULL,
       paused_reason = NULL,
       updated_at = excluded.updated_at`,
  ).run(seriesId, now);
}

function pauseTask(db: Database.Database, seriesId: string, reason: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bo_task_retry (series_id, retry_count, paused_reason, updated_at)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(series_id) DO UPDATE SET
       paused_reason = excluded.paused_reason,
       updated_at = excluded.updated_at`,
  ).run(seriesId, reason, now);
  db.prepare("UPDATE messages_in SET status='paused' WHERE series_id = ? AND kind='task' AND status='pending'").run(
    seriesId,
  );
}

function findInflightTask(db: Database.Database): MessageInRow | null {
  const row = db
    .prepare(
      `SELECT id, status, process_after, recurrence, series_id, content
       FROM messages_in
       WHERE kind='task'
       ORDER BY
         CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
         seq DESC
       LIMIT 1`,
    )
    .get() as MessageInRow | undefined;
  return row ?? null;
}

function tryGetText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? '(no text)';
  } catch {
    return content.slice(0, 200);
  }
}

export default async function init(): Promise<void> {
  registerSignalHandler('retry', async (signal, ctx) => {
    const session = getSession(ctx.sessionId);
    if (!session) return;
    const db = openInboundDb(session.agent_group_id, session.id);
    try {
      ensureRetryTable(db);
      const task = findInflightTask(db);
      if (!task || !task.series_id) {
        log.info('bo-scheduler-tags <retry> outside task context — ignoring', { sessionId: ctx.sessionId });
        return;
      }
      const reason = signal.attributes.reason ?? '(no reason)';
      const count = bumpRetry(db, task.series_id, reason);

      if (count > RETRY_DELAYS_MIN.length) {
        let contentObj: Record<string, unknown> = {};
        try {
          contentObj = JSON.parse(task.content) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        const originalText = tryGetText(task.content);
        contentObj.text = `${HEALER_PROMPT_PREFIX}The task has failed ${count} times. Latest reason: ${reason}. Original prompt:\n\n${originalText}\n\nDiagnose, fix the root cause, then emit <healed action="..." /> if fixed or <no-fix reason="..." /> if not.`;
        const nextRunAt = new Date(Date.now() + 60_000).toISOString();
        db.prepare("UPDATE messages_in SET process_after=?, status='pending', content=? WHERE id=?").run(
          nextRunAt,
          JSON.stringify(contentObj),
          task.id,
        );
        log.info('bo-scheduler-tags: scheduled healer run', { taskId: task.id, count, reason });
        return;
      }

      const delayMin = RETRY_DELAYS_MIN[count - 1];
      const nextRunAt = new Date(Date.now() + delayMin * 60_000).toISOString();
      db.prepare("UPDATE messages_in SET process_after=?, status='pending' WHERE id=?").run(nextRunAt, task.id);
      log.info('bo-scheduler-tags: <retry> requeued', { taskId: task.id, count, delayMin, reason });
    } finally {
      db.close();
    }
  });

  registerSignalHandler('healed', async (signal, ctx) => {
    const session = getSession(ctx.sessionId);
    if (!session) return;
    const db = openInboundDb(session.agent_group_id, session.id);
    try {
      ensureRetryTable(db);
      const task = findInflightTask(db);
      if (!task || !task.series_id) return;
      resetRetry(db, task.series_id);
      const nextRunAt = new Date(Date.now() + 5_000).toISOString();
      db.prepare("UPDATE messages_in SET process_after=?, status='pending' WHERE id=?").run(nextRunAt, task.id);
      const action = signal.attributes.action ?? signal.body;
      log.info('bo-scheduler-tags: <healed> re-fired task', { taskId: task.id, action });
    } finally {
      db.close();
    }
  });

  registerSignalHandler('no-fix', async (signal, ctx) => {
    const session = getSession(ctx.sessionId);
    if (!session) return;
    const db = openInboundDb(session.agent_group_id, session.id);
    try {
      ensureRetryTable(db);
      const task = findInflightTask(db);
      if (!task || !task.series_id) return;
      const reason = signal.attributes.reason ?? signal.body ?? '(no reason)';
      pauseTask(db, task.series_id, reason);
      log.warn('bo-scheduler-tags: <no-fix> task paused', { taskId: task.id, seriesId: task.series_id, reason });
    } finally {
      db.close();
    }
  });

  log.info('bo-scheduler-tags: handlers registered for retry/healed/no-fix (v2 messages_in mode)');
}
