/**
 * Standalone OAuth token refresher for Claude Code.
 * Runs as a launchd agent every 5 minutes.
 *
 * Strategy:
 *   1. Primary: Direct HTTP refresh via console.anthropic.com/v1/oauth/token
 *      using the refresh_token grant. Handles token rotation (saves new refresh token).
 *   2. Fallback: `claude --print --model haiku` which triggers CLI-level refresh.
 *
 *   Warning at 90 min, refresh attempted at 30 min or when expired.
 */
import { execFileSync, execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { request } from 'https';

const CLAUDE_PATH = '/opt/homebrew/bin/claude';
const ONECLI_PATH = process.env.HOME + '/.local/bin/onecli';
const CREDENTIALS_FILE = join(process.env.HOME, '.claude', '.credentials.json');
const NANOCLAW_OAUTH_FILE = join(
  process.env.HOME,
  '.config',
  'nanoclaw',
  'claude-oauth.json',
);

const WARN_THRESHOLD_MS = 90 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;
const AUTH_EXPIRED_FLAG = '/tmp/claude-auth-expired';

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getTokenState() {
  if (!existsSync(CREDENTIALS_FILE)) {
    return { accessToken: null, expiresAt: 0, hasRefreshToken: false, raw: null };
  }
  const raw = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const oauth = raw?.claudeAiOauth;
  return {
    accessToken: oauth?.accessToken ?? null,
    refreshToken: oauth?.refreshToken ?? null,
    expiresAt: oauth?.expiresAt ?? 0,
    hasRefreshToken: !!oauth?.refreshToken,
    raw,
  };
}

function notify(title, message) {
  try {
    execSync(
      `osascript -e 'display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"'`,
      { timeout: 5000 },
    );
  } catch {
    // Non-critical
  }
}

function syncCredentials(raw) {
  try {
    mkdirSync(join(process.env.HOME, '.config', 'nanoclaw'), { recursive: true });
    writeFileSync(NANOCLAW_OAUTH_FILE, JSON.stringify(raw));
    log('NanoClaw credentials synced');
  } catch (err) {
    log(`NanoClaw credentials sync failed: ${err.message || err}`);
  }

  const accessToken = raw?.claudeAiOauth?.accessToken;
  if (!accessToken) return;
  try {
    const secretsRaw = execFileSync(ONECLI_PATH, ['secrets', 'list']).toString();
    const secrets = JSON.parse(secretsRaw);
    const anthropicSecret = secrets?.data?.find((s) => s.type === 'anthropic');
    if (anthropicSecret?.id) {
      execFileSync(ONECLI_PATH, [
        'secrets',
        'update',
        '--id',
        anthropicSecret.id,
        '--value',
        accessToken,
      ]);
      log('OneCLI synced');
    }
  } catch (err) {
    log(`OneCLI sync failed: ${err.message || err}`);
  }
}

// (Previously: direct HTTP refresh against /v1/oauth/token. Removed —
// turned this script into a refresh racer competing with Claude CLI and
// every long-running Claude SDK session. Now we only invoke `claude
// --print` to trigger a refresh, so Claude is the single OAuth client.)

try {
  let before = getTokenState();

  if (!before.accessToken) {
    // Self-heal: canonical credentials file is missing. If our cache still
    // has a valid blob, restore canonical from it. The cached refresh token
    // may have been rotated by another process, but at least Claude CLI +
    // Bo's containers + OneCLI gateway will see SOMETHING usable until the
    // user manually re-logs in. This is the v2-specific failure mode that
    // took down Bo for 5+ hours earlier today.
    if (existsSync(NANOCLAW_OAUTH_FILE)) {
      try {
        const cacheRaw = JSON.parse(readFileSync(NANOCLAW_OAUTH_FILE, 'utf8'));
        const cacheOauth = cacheRaw?.claudeAiOauth;
        if (cacheOauth?.accessToken && cacheOauth?.refreshToken) {
          mkdirSync(join(process.env.HOME, '.claude'), { recursive: true });
          writeFileSync(CREDENTIALS_FILE, JSON.stringify(cacheRaw), { mode: 0o600 });
          log(`Canonical credentials file was missing — restored from cache`);
          // Re-read state from restored file
          before = getTokenState();
        }
      } catch (err) {
        log(`Cache restore failed: ${err.message || err}`);
      }
    }
  }

  if (!before.accessToken) {
    log('No OAuth credentials found — run: claude auth login');
    if (!existsSync(AUTH_EXPIRED_FLAG)) {
      writeFileSync(AUTH_EXPIRED_FLAG, new Date().toISOString());
      notify('NanoClaw: Auth Expired', 'Claude OAuth token expired. Run: claude auth login');
    }
    process.exit(0);
  }

  const msUntilExpiry = before.expiresAt - Date.now();
  const minRemaining = Math.round(msUntilExpiry / 60000);

  if (msUntilExpiry > WARN_THRESHOLD_MS) {
    log(`Token valid (${minRemaining} min remaining) — syncing`);
    syncCredentials(before.raw);
    if (existsSync(AUTH_EXPIRED_FLAG)) {
      unlinkSync(AUTH_EXPIRED_FLAG);
      log('Cleared stale auth-expired flag');
    }
    process.exit(0);
  }

  if (msUntilExpiry > REFRESH_THRESHOLD_MS) {
    log(`Token expires in ${minRemaining} min — warning user`);
    notify(
      'NanoClaw: Auth Expiring',
      `Claude token expires in ${minRemaining} min. Auto-refresh will run soon.`,
    );
    syncCredentials(before.raw);
    process.exit(0);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Within refresh window or expired.
  //
  // Anthropic refresh tokens are SINGLE-USE — they rotate on every refresh.
  // Multiple Claude clients share ~/.claude/.credentials.json but each
  // holds its own copy of the refresh token IN MEMORY. When one rotates,
  // all others' in-memory copies become invalid. The losers' next request
  // 401s → Claude CLI deletes credentials → everyone is logged out.
  //
  // Active racers on this host: interactive `claude`, my Claude Code
  // session(s), each long-running Bo container's Claude SDK, and (until
  // now) this refresher's own HTTP refresh.
  //
  // Fix: stop being a racer. NEVER call /v1/oauth/token ourselves.
  // ALWAYS use `claude --print` to trigger a refresh — it runs as a fresh
  // process that re-reads the file, refreshes, writes the new token, and
  // exits. The fs.watch in v2 host catches the file write and syncs to
  // cache + OneCLI immediately.
  if (msUntilExpiry <= 0) {
    log(`Token EXPIRED (${Math.abs(minRemaining)} min ago) — invoking claude CLI to refresh`);
  } else {
    log(`Token expires in ${minRemaining} min — invoking claude CLI to refresh`);
  }

  // claude --print runs as a fresh process; it re-reads the file, uses its
  // refresh token to call /v1/oauth/token, writes the rotated tokens, and
  // exits. No in-memory copies survive to race against the new tokens.
  try {
    execSync(`echo "ping" | ${CLAUDE_PATH} --print --model haiku 2>/dev/null`, {
      timeout: 60000,
    });
  } catch {
    log('Claude CLI fallback finished (may have errored — checking token state)');
  }

  const after = getTokenState();
  const newMinRemaining = Math.round((after.expiresAt - Date.now()) / 60000);

  if (after.expiresAt > before.expiresAt) {
    log(`CLI fallback refreshed token — new expiry in ${newMinRemaining} min`);
    syncCredentials(after.raw);
    if (existsSync(AUTH_EXPIRED_FLAG)) unlinkSync(AUTH_EXPIRED_FLAG);
  } else {
    const isExpired = after.expiresAt - Date.now() <= 0;
    log(`Token NOT refreshed (${newMinRemaining} min remaining)`);

    if (isExpired || !after.accessToken) {
      log('TOKEN DEAD — writing flag and sending notification');
      writeFileSync(AUTH_EXPIRED_FLAG, new Date().toISOString());
      notify('NanoClaw: Auth Expired', 'Claude OAuth token expired. Run: claude auth login');
    } else {
      log('Token still alive but refresh failed — notifying user');
      notify(
        'NanoClaw: Auth Expiring Soon',
        `Claude token expires in ${newMinRemaining} min. Auto-refresh is failing. Run: claude auth login`,
      );
      syncCredentials(after.raw);
    }
  }
} catch (err) {
  log(`Error: ${err.message || err}`);
  process.exit(1);
}
