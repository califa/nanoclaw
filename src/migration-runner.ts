/**
 * bo-features migration runner.
 *
 * Trunk's `src/db/migrations/index.ts` only loads files compiled into
 * `src/db/migrations/*`. The bo-features branch keeps its migrations in a
 * sibling `migrations/` directory so they don't conflict with upstream
 * migration ordering.
 *
 * This module scans `migrations/bo-*.ts`, dynamically imports each, and
 * calls `apply(db)`. Each migration is responsible for its own idempotence
 * (CREATE TABLE IF NOT EXISTS / safe-add-column patterns).
 *
 * Tracking: applied migration names land in a `bo_migrations` table so we
 * don't re-run them. Migrations themselves still need to be idempotent —
 * if a user deletes the tracking row, re-running shouldn't break.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type Database from 'better-sqlite3';
import { log } from './log.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface MigrationModule {
  apply: (db: Database.Database) => void;
}

function ensureTrackingTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bo_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

export async function runBoMigrations(db: Database.Database): Promise<void> {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log.debug('bo-features migrations dir not present, skipping', { path: MIGRATIONS_DIR });
    return;
  }

  ensureTrackingTable(db);
  const appliedRows = db.prepare('SELECT name FROM bo_migrations').all() as { name: string }[];
  const applied = new Set(appliedRows.map((r) => r.name));

  const entries = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^bo-\d+.*\.(ts|js)$/.test(f))
    .sort();

  for (const f of entries) {
    if (applied.has(f)) continue;

    const filePath = path.join(MIGRATIONS_DIR, f);
    try {
      const mod = (await import(pathToFileURL(filePath).href)) as MigrationModule;
      if (typeof mod.apply !== 'function') {
        log.warn('bo-features migration missing apply() export, skipping', { migration: f });
        continue;
      }
      mod.apply(db);
      db.prepare('INSERT INTO bo_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      log.info('bo-features migration applied', { migration: f });
    } catch (err) {
      log.error('bo-features migration failed', { migration: f, err });
      // Don't throw — let host keep starting. Next boot will retry.
    }
  }
}
