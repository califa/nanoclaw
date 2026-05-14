/**
 * bo-004 — restore v1's suggested_tasks + meeting_briefs tables.
 *
 * Bo's v1 conversations referenced these endpoints heavily as cross-session
 * memory ("Check what's already been suggested: curl ...9224/tasks?status=
 * pending"). They live in v2.db under the bo- prefix to keep them off the
 * upstream migration namespace.
 */
import type Database from 'better-sqlite3';

export function apply(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bo_suggested_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      source_detail TEXT,
      task TEXT NOT NULL,
      who_for TEXT,
      priority TEXT,
      suggested_actions TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bo_suggested_tasks_status ON bo_suggested_tasks(status);

    CREATE TABLE IF NOT EXISTS bo_meeting_briefs (
      event_id TEXT PRIMARY KEY,
      title TEXT,
      start_time TEXT,
      end_time TEXT,
      attendees TEXT,
      brief TEXT,
      open_items TEXT,
      status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bo_meeting_briefs_start ON bo_meeting_briefs(start_time);
  `);
  console.log('[bo-004] suggested_tasks + meeting_briefs tables ready');
}
