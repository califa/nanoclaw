/**
 * bo-memory-write — host-side handler for <memory-write> signals.
 *
 * Container skills (bo-self-learning, bo-tags) describe a protocol where
 * Bo emits structured tags in his outbound message to persist learnings:
 *
 *   <memory-write target="wiki/personal/bo-mistakes.md" mode="append">
 *   ## fact-attribution
 *   Rule: Don't claim a specific person is leading...
 *   </memory-write>
 *
 * This plugin parses those tags out of outbound messages, writes the body
 * to the resolved host path (under the wiki tree), and strips the tag from
 * what reaches Slack so it doesn't appear in the user-visible reply.
 *
 * Modes:
 *   append          — appends body to the file (default; creates if missing)
 *   replace-section — replaces a `## <section>` block (or section attr) with body
 *
 * Targets are resolved relative to the wiki dir. Only paths under the wiki
 * dir are allowed — anything else is rejected with a log line.
 */
import fs from 'fs';
import path from 'path';
import { registerSignalHandler } from '../../extension-points.js';
import { log } from '../../log.js';

const WIKI_DIR = '/Users/joel/Brain/xtra/wiki';

function resolveTarget(rel: string): string | null {
  // Strip leading ./ or /
  const cleaned = rel.replace(/^\.?\/+/, '');
  const abs = path.resolve(WIKI_DIR, cleaned);
  // Defence against ../ escapes
  if (!abs.startsWith(WIKI_DIR + path.sep)) return null;
  return abs;
}

function appendToFile(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const separator = needsNewline ? '\n\n' : existing.length > 0 ? '\n' : '';
  fs.writeFileSync(filePath, existing + separator + body.trim() + '\n');
}

function replaceSection(filePath: string, sectionName: string, newBody: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const re = new RegExp(`(^##\\s+${escapeRegex(sectionName)}\\s*\\n)([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm');
  if (re.test(existing)) {
    const replaced = existing.replace(re, `$1${newBody.trim()}\n\n`);
    fs.writeFileSync(filePath, replaced);
  } else {
    // Section doesn't exist yet — append the whole thing with header.
    const sep = existing.endsWith('\n') ? '\n' : existing.length > 0 ? '\n\n' : '';
    fs.writeFileSync(filePath, existing + sep + `## ${sectionName}\n${newBody.trim()}\n`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default async function init(): Promise<void> {
  registerSignalHandler('memory-write', async (signal, ctx) => {
    const target = signal.attributes.target;
    const mode = signal.attributes.mode || 'append';
    const section = signal.attributes.section;

    if (!target) {
      log.warn('bo-memory-write: missing target attribute', { sessionId: ctx.sessionId });
      return;
    }
    const filePath = resolveTarget(target);
    if (!filePath) {
      log.warn('bo-memory-write: target outside wiki dir, rejecting', { target, sessionId: ctx.sessionId });
      return;
    }

    try {
      if (mode === 'append') {
        appendToFile(filePath, signal.body);
        log.info('bo-memory-write: appended', {
          target,
          bytes: signal.body.length,
          sessionId: ctx.sessionId,
        });
      } else if (mode === 'replace-section') {
        if (!section) {
          log.warn('bo-memory-write: replace-section requires section attribute', { sessionId: ctx.sessionId });
          return;
        }
        replaceSection(filePath, section, signal.body);
        log.info('bo-memory-write: section replaced', {
          target,
          section,
          bytes: signal.body.length,
          sessionId: ctx.sessionId,
        });
      } else {
        log.warn('bo-memory-write: unknown mode', { mode, sessionId: ctx.sessionId });
      }
    } catch (err) {
      log.error('bo-memory-write: write failed', { target, mode, err });
    }
  });

  log.info('bo-memory-write: signal handler registered (target/mode/section)');
}
