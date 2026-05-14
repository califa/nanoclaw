/**
 * bo-002 — create the token_usage table for the dashboard.
 *
 * Idempotent — CREATE TABLE IF NOT EXISTS.
 */
import type Database from 'better-sqlite3';

export function apply(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_group_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      ts TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_group ON token_usage(agent_group_id, ts);
    CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(ts);
  `);
  console.log('[bo-002] token_usage table ready');
}
