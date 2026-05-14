/**
 * bo-001 — add retry tracking columns to scheduled_tasks.
 *
 * The bo-scheduler-tags plugin reads/writes these. Idempotent — uses
 * `ALTER TABLE ... ADD COLUMN` which fails silently in better-sqlite3 when
 * the column already exists (we wrap in try/catch).
 */
import type Database from 'better-sqlite3';

function safeAdd(db: Database.Database, sql: string, label: string): void {
  try {
    db.exec(sql);
    console.log(`[bo-001] added ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate column name/i.test(msg)) {
      // already applied — fine
      return;
    }
    throw err;
  }
}

export function apply(db: Database.Database): void {
  // Confirm the host's scheduled_tasks table exists. If not, bo-scheduler-tags
  // is going to be a no-op anyway; nothing to migrate.
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get();
  if (!row) {
    console.log('[bo-001] scheduled_tasks table not present — skipping');
    return;
  }

  safeAdd(db, 'ALTER TABLE scheduled_tasks ADD COLUMN retry_count INTEGER DEFAULT 0', 'retry_count');
  safeAdd(db, 'ALTER TABLE scheduled_tasks ADD COLUMN last_failure_reason TEXT', 'last_failure_reason');
  safeAdd(db, 'ALTER TABLE scheduled_tasks ADD COLUMN paused_reason TEXT', 'paused_reason');
}
