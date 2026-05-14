#!/usr/bin/env node
/**
 * Regression check for bo-features customizations on top of nanoclaw v2.
 *
 * Run this AFTER pulling a fresh v2 upstream — it exercises the v1-equivalent
 * behaviors that have been added or restored in this install. Each check is
 * deliberately small and independent so failures pinpoint exactly what broke.
 *
 * Exit code: 0 if everything passes, 1 if any check fails. Designed to be
 * scriptable into a post-merge hook.
 *
 * Usage:
 *   node scripts/check-bo-features.mjs
 *   node scripts/check-bo-features.mjs --skip docker   # skip slow image checks
 */
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const SKIP_DOCKER = args.has('--skip=docker') || args.has('--skip-docker');

let failures = 0;
let passes = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error('returned false');
    console.log(`  ✓ ${name}${typeof result === 'string' ? `: ${result}` : ''}`);
    passes++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

function group(label, fn) {
  console.log(`\n${label}`);
  fn();
}

function curl(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function main() {
  console.log('bo-features regression check\n');

  group('Upstream patches (in container/agent-runner)', () => {
    check('poll-loop bare-text fallback present', () => {
      const file = path.join(ROOT, 'container/agent-runner/src/poll-loop.ts');
      const src = fs.readFileSync(file, 'utf-8');
      if (!src.includes('findByRouting')) throw new Error('findByRouting import missing');
      if (!src.includes('falling back to origin destination')) {
        throw new Error('bare-text fallback log line missing — silent-drop regression returned');
      }
      return 'fallback line found';
    });
  });

  group('Plugins (src/plugins/bo-*)', () => {
    const required = [
      'bo-dreaming',
      'bo-ha-shortcut',
      'bo-memory-write',
      'bo-reviewer-enforcement',
      'bo-scheduler-tags',
      'bo-token-usage',
      'bo-voice',
    ];
    for (const p of required) {
      check(`plugin ${p}/index.ts exists`, () => {
        const f = path.join(ROOT, 'src/plugins', p, 'index.ts');
        if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
        return null;
      });
    }
  });

  group('Migrations (migrations/bo-*)', () => {
    const required = [
      'bo-001-scheduled-task-retry.ts',
      'bo-002-token-usage.ts',
      'bo-003-token-usage-v1-compat.ts',
      'bo-004-suggested-tasks-meetings.ts',
    ];
    for (const m of required) {
      check(`migration ${m}`, () => {
        const f = path.join(ROOT, 'migrations', m);
        if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
        return null;
      });
    }
  });

  group('Custom DB tables present', () => {
    const dbPath = path.join(ROOT, 'data/v2.db');
    if (!fs.existsSync(dbPath)) {
      console.log('  · v2.db not found, skipping table checks');
      return;
    }
    const tables = ['bo_reviewer_blocks', 'bo_suggested_tasks', 'bo_meeting_briefs', 'session_context'];
    for (const t of tables) {
      check(`table ${t}`, () => {
        const out = execSync(
          `pnpm exec tsx scripts/q.ts data/v2.db "SELECT name FROM sqlite_master WHERE type='table' AND name='${t}';"`,
          { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        if (!out.includes(t)) throw new Error('not present');
        return null;
      });
    }
  });

  group('Host-side scripts + launchd jobs', () => {
    check('scripts/refresh-oauth.mjs honors HTTP refresh', () => {
      const src = fs.readFileSync(path.join(ROOT, 'scripts/refresh-oauth.mjs'), 'utf-8');
      if (!src.includes('console.anthropic.com/v1/oauth/token')) {
        throw new Error('HTTP refresh primary path missing — regression to slow `claude --print` only');
      }
      return null;
    });
    check('scripts/cleanup-sessions.sh targets v2 paths', () => {
      const src = fs.readFileSync(path.join(ROOT, 'scripts/cleanup-sessions.sh'), 'utf-8');
      if (!src.includes('data/v2.db') || !src.includes('data/v2-sessions')) {
        throw new Error('script still references v1 paths');
      }
      return null;
    });
    check('com.claude.token-refresh launchd loaded', () => {
      const out = execSync('launchctl list 2>/dev/null | grep com.claude.token-refresh', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!out.trim()) throw new Error('not loaded');
      return null;
    });
    check('com.nanoclaw.obsidian-bridge launchd loaded', () => {
      const out = execSync('launchctl list 2>/dev/null | grep com.nanoclaw.obsidian-bridge', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!out.trim()) throw new Error('not loaded');
      return null;
    });
  });

  group('Helium API endpoints (port 9224)', async () => {
    for (const p of ['/usage', '/tasks', '/meetings']) {
      check(`GET ${p} → 200`, () => {
        return curl(`http://localhost:9224${p}`).then((r) => {
          if (r.status !== 200) throw new Error(`got ${r.status}`);
          return null;
        });
      });
    }
  });

  group('Obsidian bridge', () => {
    check('GET http://localhost:27999/health → 200', () => {
      return curl('http://localhost:27999/health').then((r) => {
        if (r.status !== 200) throw new Error(`got ${r.status}`);
        return null;
      });
    });
  });

  if (!SKIP_DOCKER) {
    group('Container image (slow — pass --skip=docker to bypass)', () => {
      check('image nanoclaw-agent-v2-* exists', () => {
        const out = execSync('docker image ls --format "{{.Repository}}" | grep nanoclaw-agent-v2 | head -1', {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (!out) throw new Error('no nanoclaw-agent-v2 image');
        return out;
      });
      check('image has Noto CJK fonts (INSTALL_CJK_FONTS=true)', () => {
        const image = execSync(
          'docker image ls --format "{{.Repository}}:{{.Tag}}" | grep nanoclaw-agent-v2 | head -1',
          { encoding: 'utf-8' },
        ).trim();
        const n = execSync(
          `docker run --rm --entrypoint bash ${image} -c 'fc-list | grep -ic "Noto Sans CJK"'`,
          { encoding: 'utf-8' },
        ).trim();
        if (Number(n) < 5) throw new Error(`only ${n} CJK font faces`);
        return `${n} CJK faces`;
      });
    });
  }

  group('Wiki / Brain layout', () => {
    check('Brain/xtra/wiki/personal exists', () => {
      const p = '/Users/joel/Brain/xtra/wiki/personal';
      if (!fs.existsSync(p)) throw new Error('missing');
      return null;
    });
    check('Brain/xtra/wiki/personal/bo-mistakes.md exists', () => {
      const p = '/Users/joel/Brain/xtra/wiki/personal/bo-mistakes.md';
      if (!fs.existsSync(p)) throw new Error('missing');
      return null;
    });
  });

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
