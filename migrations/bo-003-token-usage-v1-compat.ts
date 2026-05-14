/**
 * bo-003 — extend token_usage with v1-compatible columns so the user's
 * existing dashboard at :3002 can read v2 data with no SQL changes.
 *
 * Adds columns idempotently: ALTER TABLE ADD COLUMN throws if the column
 * exists; we swallow that case.
 *
 * After this migration, token_usage has both the v2-style columns
 * (session_id, agent_group_id, model) and the v1-style columns the
 * dashboard expects (timestamp, group_folder, chat_jid, source,
 * total_cost_usd, num_turns, duration_ms, duration_api_ms, tools_used).
 */
import type Database from 'better-sqlite3';

function safeAdd(db: Database.Database, sql: string, label: string): void {
  try {
    db.exec(sql);
    console.log(`[bo-003] added ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate column name/i.test(msg)) return;
    throw err;
  }
}

export function apply(db: Database.Database): void {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'").get();
  if (!row) {
    console.log('[bo-003] token_usage table not present — skipping (run bo-002 first)');
    return;
  }

  // v1-shape columns the user's dashboard queries:
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN timestamp TEXT', 'timestamp');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN group_folder TEXT', 'group_folder');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN chat_jid TEXT', 'chat_jid');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN source TEXT', 'source');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN total_cost_usd REAL DEFAULT 0', 'total_cost_usd');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN num_turns INTEGER DEFAULT 0', 'num_turns');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN duration_ms INTEGER DEFAULT 0', 'duration_ms');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN duration_api_ms INTEGER DEFAULT 0', 'duration_api_ms');
  safeAdd(db, 'ALTER TABLE token_usage ADD COLUMN tools_used TEXT', 'tools_used');

  // For previously-inserted rows (from before this migration), backfill
  // timestamp from the v2-style `ts` column so the dashboard's ORDER BY works.
  db.exec('UPDATE token_usage SET timestamp = ts WHERE timestamp IS NULL AND ts IS NOT NULL');

  // Index for dashboard's ORDER BY timestamp DESC.
  db.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp)');

  // Session context window snapshot — one row per session, latest input_tokens
  // (= current context window size for the next request). Updated by
  // bo-token-usage on each turn.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_context (
      session_id TEXT PRIMARY KEY,
      agent_group_id TEXT NOT NULL,
      group_folder TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_context_group ON session_context(agent_group_id);
    CREATE INDEX IF NOT EXISTS idx_session_context_updated ON session_context(updated_at);
  `);
  console.log('[bo-003] session_context ready');
}
