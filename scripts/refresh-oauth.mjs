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

/**
 * Direct HTTP OAuth refresh. ~500ms request → file write → done.
 *
 * Why HTTP (not `claude --print`): the cron has to refresh proactively
 * to keep access tokens fresh ahead of Claude CLI bg_workers needing
 * them. `claude --print` is a full Node process startup + several
 * file reads + the refresh + a generation call (~5-10 sec). During
 * that 5-10 sec window, any in-process claude bg_worker can ALSO
 * attempt refresh, creating a rotation race that ends in 401. HTTP
 * refresh shrinks the window 10-20×.
 *
 * Returns true on success, false on failure (caller falls back to CLI).
 */
async function httpRefresh(refreshToken) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString();

    const url = new URL(OAUTH_TOKEN_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'claude-cli/1.0',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          log(`HTTP refresh failed: ${res.statusCode} ${data.slice(0, 200)}`);
          resolve(false);
          return;
        }
        try {
          const result = JSON.parse(data);
          if (!result.access_token || !result.refresh_token) {
            log(`HTTP refresh: unexpected response shape`);
            resolve(false);
            return;
          }

          const raw = existsSync(CREDENTIALS_FILE) ? JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) : {};
          const expiresAt = Date.now() + result.expires_in * 1000;
          if (!raw.claudeAiOauth) raw.claudeAiOauth = {};
          raw.claudeAiOauth.accessToken = result.access_token;
          raw.claudeAiOauth.refreshToken = result.refresh_token;
          raw.claudeAiOauth.expiresAt = expiresAt;

          // Atomic write: write to .tmp, then rename. Avoids partial files.
          const tmp = `${CREDENTIALS_FILE}.tmp.${process.pid}.${Date.now()}`;
          writeFileSync(tmp, JSON.stringify(raw), { mode: 0o600 });
          execSync(`mv "${tmp}" "${CREDENTIALS_FILE}"`);

          log(`HTTP refresh succeeded — new expiry in ${Math.round(result.expires_in / 60)} min`);
          syncCredentials(raw);
          resolve(true);
        } catch (err) {
          log(`HTTP refresh parse error: ${err.message}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      log(`HTTP refresh network error: ${err.message}`);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

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
    log(`Token EXPIRED (${Math.abs(minRemaining)} min ago) — attempting HTTP refresh`);
  } else {
    log(`Token expires in ${minRemaining} min — attempting HTTP refresh`);
  }

  // PRIMARY: direct HTTP refresh. Fast (~500ms), single file write,
  // shrinks the race window so much that overlapping bg_worker refreshes
  // become very unlikely. v1 added this exact pattern in commit ee25101
  // ("OAuth refresher tries direct HTTP first, falls back to claude CLI")
  // precisely to fix recurring logouts. Don't remove it.
  if (before.hasRefreshToken) {
    const ok = await httpRefresh(before.refreshToken);
    if (ok) {
      if (existsSync(AUTH_EXPIRED_FLAG)) unlinkSync(AUTH_EXPIRED_FLAG);
      process.exit(0);
    }
    log('HTTP refresh failed — falling back to claude --print');
  } else {
    log('No refresh token available — falling back to claude --print');
  }

  // FALLBACK: invoke claude --print. Larger race window but works when
  // HTTP refresh is blocked (e.g. corporate proxy) or returns unexpected
  // responses. Only reached if HTTP refresh fails.
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
