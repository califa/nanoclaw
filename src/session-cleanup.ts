/**
 * Periodic session cleanup driver.
 *
 * Runs scripts/cleanup-sessions.sh at startup (after a delay) and every
 * 24 hours. Carried over from v1's startSessionCleanup() in src/index.ts.
 *
 * The bash script does the actual file pruning — kept in shell so it's
 * easy to read and audit, and so it works regardless of the host process
 * being alive at the moment of pruning.
 */
import path from 'path';
import { execFile } from 'child_process';
import { log } from './log.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
const STARTUP_DELAY = 30_000;

function runCleanup(): void {
  const script = path.resolve(process.cwd(), 'scripts/cleanup-sessions.sh');
  execFile('/bin/bash', [script], { timeout: 120_000 }, (err, stdout) => {
    if (err) {
      log.warn('Session cleanup failed', { err: err.message });
      return;
    }
    const summary = stdout
      .trim()
      .split('\n')
      .filter((l) => l.includes('freed'))
      .pop();
    if (summary) log.info('Session cleanup', { summary });
  });
}

export function startSessionCleanup(): void {
  setTimeout(runCleanup, STARTUP_DELAY).unref?.();
  setInterval(runCleanup, CLEANUP_INTERVAL).unref?.();
  log.info('Session cleanup scheduled', { intervalHours: 24 });
}
