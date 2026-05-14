/**
 * OAuth credentials sync — keep a cached copy of the user's Claude Code
 * credentials at ~/.config/nanoclaw/claude-oauth.json so containers always
 * have a valid token to copy in, even if the canonical
 * ~/.claude/.credentials.json is transiently absent.
 *
 * v1 history: Claude CLI used to keep credentials in macOS Keychain under
 * "Claude Code-credentials". A v1 update moved it to a JSON file at
 * ~/.claude/.credentials.json. We treat that file as source-of-truth but
 * cache an immediate copy because the file gets rewritten/replaced during
 * the CLI's own refresh and login flows; reading mid-write yields ENOENT.
 * The cached copy is also kept current by the launchd refresher
 * (scripts/refresh-oauth.mjs, runs every 5 minutes) which performs the
 * actual OAuth refresh against console.anthropic.com.
 *
 * Also keeps OneCLI's stored Anthropic secret in sync: the gateway proxies
 * api.anthropic.com calls and replaces the Bearer header with the stored
 * secret on each call, so the stored credential MUST be the latest access
 * token or the container's requests start 401-ing.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { log } from './log.js';

const SRC_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const DEST_DIR = path.join(os.homedir(), '.config', 'nanoclaw');
const DEST_FILE = path.join(DEST_DIR, 'claude-oauth.json');

interface OAuthBlob {
  claudeAiOauth?: { accessToken?: string; refreshToken?: string; scopes?: string[]; expiresAt?: number };
}

function readBlob(p: string): OAuthBlob | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as OAuthBlob;
  } catch {
    return null;
  }
}

function isValid(blob: OAuthBlob | null): boolean {
  const o = blob?.claudeAiOauth;
  return !!(o?.accessToken && o?.refreshToken && o?.scopes);
}

function syncToOneCli(accessToken: string): void {
  try {
    const secretsRaw = execFileSync('onecli', ['secrets', 'list']).toString();
    const secrets = JSON.parse(secretsRaw) as { data?: Array<{ id: string; type: string }> };
    const anthropicSecret = secrets.data?.find((s) => s.type === 'anthropic');
    if (anthropicSecret?.id) {
      execFileSync('onecli', ['secrets', 'update', '--id', anthropicSecret.id, '--value', accessToken]);
      log.info('OneCLI Anthropic credential refreshed');
    }
  } catch {
    log.debug('OneCLI credential refresh failed (non-critical)');
  }
}

/** Atomic write: write to .tmp + rename. Avoids partial files on disk-full / SIGKILL. */
function atomicWrite(filePath: string, content: string, mode = 0o600): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
}

export async function syncOAuthCredentials(): Promise<void> {
  try {
    // Case 1: canonical missing — try to self-heal from cache.
    // This is the v2-specific failure mode that took down Bo for 5+ hours
    // earlier today. The Claude CLI sometimes deletes ~/.claude/.credentials.json
    // on auth failure (its logout-on-401 path), leaving every refresher tick
    // logging "No OAuth credentials found" until manual re-login. Restoring
    // from cache buys time until the user logs in again — Bo's containers
    // and OneCLI keep working with the last-known-good token instead of
    // immediately going dark.
    if (!fs.existsSync(SRC_FILE)) {
      // Self-heal: restore from cache, but ONLY if cache is still not
      // expired. Restoring a stale cache just causes more 401 → delete
      // → cascade because the refresh token in there has likely been
      // rotated by whoever just wrote (and we missed catching).
      const cache = readBlob(DEST_FILE);
      const expiresAt = cache?.claudeAiOauth?.expiresAt ?? 0;
      const stillValid = isValid(cache) && expiresAt > Date.now();
      if (stillValid) {
        try {
          atomicWrite(SRC_FILE, fs.readFileSync(DEST_FILE, 'utf8'), 0o600);
          log.warn('Canonical credentials file was missing — restored from cache');
        } catch (err) {
          log.warn('Failed to restore canonical from cache', { err });
        }
      } else if (isValid(cache)) {
        log.warn('Canonical missing AND cache is expired — needs `claude auth login`');
      } else if (fs.existsSync(DEST_FILE)) {
        log.debug('Credentials file missing, cache invalid — needs claude auth login');
      } else {
        log.warn('No OAuth credentials available — cloud connectors will be unavailable');
      }
      return;
    }

    const data = readBlob(SRC_FILE);
    if (!isValid(data)) return;
    const oauth = data!.claudeAiOauth!;

    fs.mkdirSync(DEST_DIR, { recursive: true });
    atomicWrite(DEST_FILE, JSON.stringify(data), 0o644);
    log.info('OAuth credentials synced');

    syncToOneCli(oauth.accessToken!);
  } catch {
    if (fs.existsSync(DEST_FILE)) {
      log.debug('Credentials sync failed, using cached copy');
    } else {
      log.warn('No OAuth credentials available — cloud connectors will be unavailable');
    }
  }
}

/**
 * fs.watch the canonical credentials file. On any change, sync immediately
 * to the cache + OneCLI.
 *
 * Also watches every per-agent-group .claude-shared dir for credential
 * writes from inside long-running containers. Claude SDK in a container
 * also rotates the refresh token when it nears expiry, and the rotated
 * token is written to /home/node/.claude/.credentials.json which is
 * mounted from data/v2-sessions/<group>/.claude-shared/. If we don't
 * catch those writes and propagate back to ~/.claude + cache, the NEXT
 * container spawn reads stale credentials and immediately 401s.
 *
 * Returns the watchers so callers can close on shutdown.
 */
export function startOAuthFileWatcher(): fs.FSWatcher[] {
  const watchers: fs.FSWatcher[] = [];
  const debounce = new Map<string, NodeJS.Timeout>();

  // 1. Canonical at ~/.claude/.credentials.json
  const canonicalDir = path.dirname(SRC_FILE);
  const canonicalFile = path.basename(SRC_FILE);
  try {
    if (fs.existsSync(canonicalDir)) {
      const w = fs.watch(canonicalDir, (eventType, changed) => {
        if (changed !== canonicalFile) return;
        const key = 'canonical';
        if (debounce.get(key)) clearTimeout(debounce.get(key)!);
        debounce.set(
          key,
          setTimeout(() => {
            // Capture before-state for diagnostics so we can correlate
            // "canonical changed" events with subsequent logouts.
            let beforeExpires: number | null = null;
            try {
              if (fs.existsSync(SRC_FILE)) {
                beforeExpires = readBlob(SRC_FILE)?.claudeAiOauth?.expiresAt ?? null;
              }
            } catch {}
            log.info('OAuth watcher: canonical file changed', {
              eventType,
              exists: fs.existsSync(SRC_FILE),
              expiresAt: beforeExpires,
              expiresInMin: beforeExpires ? Math.round((beforeExpires - Date.now()) / 60_000) : null,
            });
            void syncOAuthCredentials();
          }, 100),
        );
      });
      w.on('error', (err) => log.warn('OAuth canonical watcher error', { err }));
      watchers.push(w);
      log.info('OAuth file watcher started', { file: SRC_FILE });
    }
  } catch (err) {
    log.warn('Failed to start OAuth canonical watcher', { err });
  }

  // 2. Per-agent-group .claude-shared/.credentials.json — captures writes
  //    from container-side Claude SDK refreshes. Propagates back to
  //    canonical + cache so subsequent spawns / OneCLI see the rotated
  //    token instead of stale.
  try {
    const sessionsRoot = path.join(os.homedir(), 'nanoclaw', 'data', 'v2-sessions');
    if (fs.existsSync(sessionsRoot)) {
      for (const groupId of fs.readdirSync(sessionsRoot)) {
        const sharedDir = path.join(sessionsRoot, groupId, '.claude-shared');
        if (!fs.existsSync(sharedDir)) continue;
        const sharedCredsFile = path.join(sharedDir, '.credentials.json');
        try {
          const w = fs.watch(sharedDir, (eventType, changed) => {
            if (changed !== '.credentials.json') return;
            const key = `group:${groupId}`;
            if (debounce.get(key)) clearTimeout(debounce.get(key)!);
            debounce.set(
              key,
              setTimeout(() => {
                if (fs.existsSync(sharedCredsFile)) {
                  // File was written → propagate up if newer than canonical
                  propagateGroupRefresh(sharedCredsFile, groupId);
                } else {
                  // File was deleted (container SDK got 401, cleared its
                  // credentials). Restore from canonical so the next
                  // spawn / current SDK retry sees valid tokens.
                  if (fs.existsSync(SRC_FILE)) {
                    try {
                      atomicWrite(sharedCredsFile, fs.readFileSync(SRC_FILE, 'utf8'), 0o600);
                      log.warn('Container per-group credentials deleted — restored from canonical', { groupId });
                    } catch (err) {
                      log.warn('Failed to restore per-group credentials', { groupId, err });
                    }
                  }
                }
              }, 100),
            );
          });
          w.on('error', () => {});
          watchers.push(w);
          log.info('OAuth file watcher started', { file: sharedCredsFile });
        } catch {
          /* group dir may have been deleted; skip */
        }
      }
    }
  } catch (err) {
    log.warn('Failed to start per-group OAuth watchers', { err });
  }

  return watchers;
}

/**
 * Propagate a per-group credentials refresh up to the canonical file and
 * the cache. Picks the newer expiresAt between the group file and what's
 * already in the canonical — if our canonical is newer, do nothing.
 */
function propagateGroupRefresh(groupCredsFile: string, groupId: string): void {
  try {
    const groupBlob = readBlob(groupCredsFile);
    if (!isValid(groupBlob)) return;
    const groupExpires = groupBlob?.claudeAiOauth?.expiresAt ?? 0;

    let canonicalExpires = 0;
    if (fs.existsSync(SRC_FILE)) {
      canonicalExpires = readBlob(SRC_FILE)?.claudeAiOauth?.expiresAt ?? 0;
    }

    if (groupExpires <= canonicalExpires) {
      // Canonical already as fresh as (or fresher than) this group's copy.
      return;
    }

    log.info('Container-side OAuth refresh detected — propagating to canonical', {
      groupId,
      groupExpiresMin: Math.round((groupExpires - Date.now()) / 60_000),
    });

    // Write to canonical first so any new container spawn reads fresh creds.
    atomicWrite(SRC_FILE, JSON.stringify(groupBlob), 0o600);
    // Then sync cache + OneCLI via the standard path.
    void syncOAuthCredentials();
  } catch (err) {
    log.warn('Failed to propagate group OAuth refresh', { err, groupId });
  }
}
