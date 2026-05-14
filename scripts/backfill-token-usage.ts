import Database from 'better-sqlite3';
import path from 'path';
import { initDb, getDb } from '/Users/joel/nanoclaw/src/db/connection.js';
import { runMigrations } from '/Users/joel/nanoclaw/src/db/migrations/index.js';
import { DATA_DIR } from '/Users/joel/nanoclaw/src/config.js';

async function main(): Promise<void> {
  const v2Db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(v2Db);

  const { apply } = await import('/Users/joel/nanoclaw/migrations/bo-003-token-usage-v1-compat.ts');
  apply(getDb());

  const v1 = new Database('/Users/joel/nanoclaw-v1-legacy/store/messages.db', { readonly: true });

  const rows = v1
    .prepare(
      `SELECT timestamp, group_folder, chat_jid, source, total_cost_usd,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              num_turns, duration_ms, duration_api_ms, tools_used
       FROM token_usage ORDER BY timestamp ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  console.log(`reading ${rows.length} v1 rows`);

  const groupRows = getDb().prepare('SELECT id, folder FROM agent_groups').all() as Array<{ id: string; folder: string }>;
  const folderToId = new Map<string, string>(groupRows.map((r) => [r.folder, r.id]));

  const existing = new Set<string>();
  for (const r of getDb()
    .prepare("SELECT timestamp, group_folder, total_cost_usd FROM token_usage WHERE session_id IS NULL OR session_id = ''")
    .all() as Array<{ timestamp: string; group_folder: string; total_cost_usd: number }>) {
    existing.add(`${r.timestamp}|${r.group_folder}|${r.total_cost_usd}`);
  }

  const insert = getDb().prepare(
    `INSERT INTO token_usage (
       session_id, agent_group_id, model,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, ts,
       timestamp, group_folder, chat_jid, source,
       total_cost_usd, num_turns, duration_ms, duration_api_ms, tools_used
     ) VALUES (
       'v1-legacy', @agent_group_id, 'unknown',
       @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens, @ts,
       @timestamp, @group_folder, @chat_jid, @source,
       @total_cost_usd, @num_turns, @duration_ms, @duration_api_ms, @tools_used
     )`,
  );

  let imported = 0;
  let skipped = 0;
  for (const r of rows) {
    const key = `${r.timestamp}|${r.group_folder}|${r.total_cost_usd}`;
    if (existing.has(key)) { skipped++; continue; }
    const groupFolder = r.group_folder as string;
    insert.run({
      agent_group_id: folderToId.get(groupFolder) ?? groupFolder,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      cache_creation_tokens: r.cache_creation_tokens ?? 0,
      cache_read_tokens: r.cache_read_tokens ?? 0,
      ts: r.timestamp,
      timestamp: r.timestamp,
      group_folder: groupFolder,
      chat_jid: r.chat_jid ?? null,
      source: r.source ?? null,
      total_cost_usd: r.total_cost_usd ?? 0,
      num_turns: r.num_turns ?? 0,
      duration_ms: r.duration_ms ?? 0,
      duration_api_ms: r.duration_api_ms ?? 0,
      tools_used: r.tools_used ?? null,
    });
    imported++;
  }
  console.log(`imported ${imported}, skipped ${skipped}`);
  v1.close();
}

void main();
