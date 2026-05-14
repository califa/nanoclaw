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

export async function syncOAuthCredentials(): Promise<void> {
  const srcFile = path.join(os.homedir(), '.claude', '.credentials.json');
  const destDir = path.join(os.homedir(), '.config', 'nanoclaw');
  const destFile = path.join(destDir, 'claude-oauth.json');
  try {
    if (!fs.existsSync(srcFile)) {
      if (fs.existsSync(destFile)) {
        log.debug('Credentials file missing, using cached copy');
      } else {
        log.warn('No OAuth credentials available — cloud connectors will be unavailable');
      }
      return;
    }

    const data = JSON.parse(fs.readFileSync(srcFile, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string; scopes?: string[] };
    };
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.scopes) return;

    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(destFile, JSON.stringify(data));
    log.info('OAuth credentials synced');

    // Keep OneCLI's stored Anthropic credential in sync
    try {
      const secretsRaw = execFileSync('onecli', ['secrets', 'list']).toString();
      const secrets = JSON.parse(secretsRaw) as { data?: Array<{ id: string; type: string }> };
      const anthropicSecret = secrets.data?.find((s) => s.type === 'anthropic');
      if (anthropicSecret?.id) {
        execFileSync('onecli', ['secrets', 'update', '--id', anthropicSecret.id, '--value', oauth.accessToken]);
        log.info('OneCLI Anthropic credential refreshed');
      }
    } catch {
      log.debug('OneCLI credential refresh failed (non-critical)');
    }
  } catch {
    if (fs.existsSync(destFile)) {
      log.debug('Credentials sync failed, using cached copy');
    } else {
      log.warn('No OAuth credentials available — cloud connectors will be unavailable');
    }
  }
}
