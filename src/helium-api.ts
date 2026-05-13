/**
 * Helium Tab Group API
 *
 * A lightweight HTTP server (port 9224) that lets Bo manage Helium browser
 * tabs and enforce the "Bo tab group" constraint via the Chrome DevTools
 * Protocol and the Claude extension's service worker (which has tabGroups
 * permission).
 *
 * Endpoints (all prefixed /helium):
 *   GET  /tabs            — list all page tabs
 *   GET  /bo-tabs         — list tabs in the "Bo" group
 *   GET  /is-bo-tab?targetId=<id> — check if a tab belongs to Bo group
 *   POST /watch-start     — snapshot current tab IDs, return watchId
 *   POST /watch-claim     — diff since watch-start, move new tabs to Bo group
 */

import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync } from 'child_process';

import { logger } from './legacy-logger.js';
import { readEnvFile } from './env.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
export const HELIUM_API_PORT = 9224;
const CLAUDE_EXT_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const BO_GROUP_COLOR = 'cyan';

const CREDENTIAL_ALLOWLIST_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'credential-allowlist.json');

interface CredentialAllowlist {
  vault: string;
  services: Record<string, { item: string; fields: string[] }>;
}

// Use a wrapper script that explicitly sets OP_SERVICE_ACCOUNT_TOKEN and OP_CONFIG_DIR.
// Calling op directly from Node.js execFileSync inside a launchd process hangs
// because 1Password's desktop app CLI integration intercepts the call.
const OP_WRAPPER = path.join(process.cwd(), 'scripts', 'op-wrapper.sh');

function getCredentials(service: string): Record<string, string> | null {
  let allowlist: CredentialAllowlist;
  try {
    allowlist = JSON.parse(fs.readFileSync(CREDENTIAL_ALLOWLIST_PATH, 'utf-8'));
  } catch (err) {
    logger.warn({ err }, 'Credential allowlist not found or invalid');
    return null;
  }

  const entry = allowlist.services[service];
  if (!entry) return null;

  const result: Record<string, string> = {};
  for (const field of entry.fields) {
    try {
      const opToken = process.env.OP_SERVICE_ACCOUNT_TOKEN || '';
      const opScript = path.join(process.cwd(), 'scripts', 'op-get-field.sh');

      if (field === 'one-time password') {
        const value = execFileSync('/bin/bash', [opScript, opToken, entry.item, allowlist.vault, 'otp', ''], {
          timeout: 15000,
        })
          .toString()
          .trim();
        result['otp'] = value;
      } else {
        const value = execFileSync('/bin/bash', [opScript, opToken, entry.item, allowlist.vault, 'field', field], {
          timeout: 15000,
        })
          .toString()
          .trim();
        result[field] = value;
      }
    } catch (err) {
      const stderr =
        err && typeof err === 'object' && 'stderr' in err ? (err as { stderr: Buffer }).stderr?.toString() : undefined;
      logger.warn(
        {
          service,
          field,
          error: err instanceof Error ? err.message : String(err),
          stderr,
          hasOpToken: !!process.env.OP_SERVICE_ACCOUNT_TOKEN,
        },
        'Failed to retrieve credential field',
      );
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function listTargets(): Promise<CdpTarget[]> {
  try {
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
    return res.ok ? ((await res.json()) as CdpTarget[]) : [];
  } catch {
    return [];
  }
}

async function cdpEval(wsUrl: string, expression: string, awaitPromise = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgId = Math.floor(Math.random() * 1e9);
    let done = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error('CDP timeout'))), 5000);

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: msgId,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise, returnByValue: true },
        }),
      );
    });

    ws.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as {
        id: number;
        result?: {
          result?: { value?: unknown };
          exceptionDetails?: {
            text?: string;
            exception?: { description?: string };
          };
        };
      };
      if (msg.id !== msgId) return;
      if (msg.result?.exceptionDetails) {
        finish(() =>
          reject(
            new Error(
              msg.result?.exceptionDetails?.exception?.description ||
                msg.result?.exceptionDetails?.text ||
                'CDP eval exception',
            ),
          ),
        );
      } else {
        finish(() => resolve(msg.result?.result?.value));
      }
    });

    ws.addEventListener('error', () => finish(() => reject(new Error('WebSocket error'))));
  });
}

async function getExtSw(): Promise<CdpTarget | null> {
  const targets = await listTargets();
  return targets.find((t) => t.type === 'service_worker' && t.url.includes(CLAUDE_EXT_ID)) ?? null;
}

async function evalInExt<T>(expression: string): Promise<T> {
  const sw = await getExtSw();
  if (!sw) throw new Error('Claude extension service worker not found in CDP');
  return cdpEval(sw.webSocketDebuggerUrl, expression, true) as Promise<T>;
}

async function getBoGroupId(): Promise<number | null> {
  const raw = await evalInExt<string>('chrome.tabGroups.query({title: "Bo"}).then(g => JSON.stringify(g))');
  const groups = JSON.parse(raw) as Array<{ id: number }>;
  return groups[0]?.id ?? null;
}

async function moveTabsToBoGroup(chromeTabIds: number[]): Promise<void> {
  if (chromeTabIds.length === 0) return;
  let groupId = await getBoGroupId();
  const ids = [...chromeTabIds];

  if (groupId === null) {
    const first = ids.shift()!;
    groupId = await evalInExt<number>(`chrome.tabs.group({tabIds: [${first}]}).then(id => id)`);
    await evalInExt<void>(`chrome.tabGroups.update(${groupId}, {title: "Bo", color: "${BO_GROUP_COLOR}"})`);
  }

  if (ids.length > 0) {
    await evalInExt<void>(`chrome.tabs.group({tabIds: ${JSON.stringify(ids)}, groupId: ${groupId}})`);
  }
}

/**
 * Ensure Bo has a dedicated Helium window that stays behind the user's window.
 * Returns the window ID, creating one if needed.
 */
async function ensureBoWindow(): Promise<number> {
  const boGroupId = await getBoGroupId();

  // Check if Bo already has a dedicated window
  if (boGroupId !== null) {
    const windowId = await evalInExt<number | null>(
      `chrome.tabs.query({groupId: ${boGroupId}}).then(tabs => tabs[0]?.windowId ?? null)`,
    );

    if (windowId !== null) {
      // Check that this window is NOT the user's main (focused) window
      const focusedWindowId = await evalInExt<number | null>(`chrome.windows.getLastFocused().then(w => w.id)`);
      if (windowId !== focusedWindowId) {
        return windowId;
      }
      // Bo's group is in the user's window — move it to a new one
    }
  }

  // Create a new window for Bo (focused: false keeps it behind the user's window)
  const newWindowId = await evalInExt<number>(
    `chrome.windows.create({focused: false, url: 'about:blank', state: 'minimized'}).then(w => w.id)`,
  );

  // Unminimize but keep it behind — minimized windows can't run CDP properly
  await new Promise((r) => setTimeout(r, 300));
  await evalInExt<void>(`chrome.windows.update(${newWindowId}, {state: 'normal', focused: false})`);

  return newWindowId;
}

/**
 * Create a blank tab in Bo's dedicated window and return its CDP info.
 * Bo's window stays behind the user's window — no focus steal.
 */
async function createBoTab(): Promise<{
  cdpTargetId: string;
  wsUrl: string;
} | null> {
  let newTarget: CdpTarget;
  try {
    const boWindowId = await ensureBoWindow();

    // Create the tab in Bo's window (not the user's)
    const chromeTabId = await evalInExt<number>(
      `chrome.tabs.create({active: true, url: 'about:blank', windowId: ${boWindowId}}).then(t => t.id)`,
    );

    // Keep Bo's window behind the user's
    await evalInExt<void>(
      `chrome.windows.getLastFocused({windowTypes: ['normal']}).then(w => {
        if (w.id !== ${boWindowId}) chrome.windows.update(w.id, {focused: true});
      })`,
    );

    // Wait briefly for CDP to register the new tab
    await new Promise((r) => setTimeout(r, 500));

    // Find the CDP target for this Chrome tab
    const targets = await listTargets();
    const match = targets.find((t) => t.type === 'page' && t.url === 'about:blank');
    if (!match) {
      logger.warn('Could not find CDP target for background tab');
      // Fallback to /json/new
      const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new`, {
        method: 'PUT',
      });
      newTarget = (await res.json()) as CdpTarget;
    } else {
      newTarget = match;
    }
  } catch {
    // Fallback to /json/new
    try {
      const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new`, {
        method: 'PUT',
      });
      newTarget = (await res.json()) as CdpTarget;
    } catch {
      return null;
    }
  }

  // Wait briefly for the tab to initialize
  await new Promise((r) => setTimeout(r, 300));

  // Find its Chrome tab ID via the marker technique
  const chromeId = await getChromeTabId(newTarget);
  if (chromeId === null) {
    logger.warn({ targetId: newTarget.id }, 'Could not get Chrome tab ID for new tab');
  } else {
    await moveTabsToBoGroup([chromeId]);
  }

  return { cdpTargetId: newTarget.id, wsUrl: newTarget.webSocketDebuggerUrl };
}

/**
 * Read a page's content via CDP without navigating or modifying it.
 * Works on any tab regardless of group membership.
 */
async function getTabContent(targetId: string): Promise<{
  title: string;
  url: string;
  text: string;
  html: string;
} | null> {
  const targets = await listTargets();
  const target = targets.find((t) => t.id === targetId && t.type === 'page');
  if (!target) return null;

  try {
    const title = (await cdpEval(target.webSocketDebuggerUrl, 'document.title')) as string;
    const url = (await cdpEval(target.webSocketDebuggerUrl, 'location.href')) as string;
    const text = (await cdpEval(target.webSocketDebuggerUrl, 'document.body?.innerText ?? ""')) as string;
    const html = (await cdpEval(target.webSocketDebuggerUrl, 'document.documentElement.outerHTML')) as string;
    return {
      title,
      url,
      text: text.slice(0, 50000),
      html: html.slice(0, 200000),
    };
  } catch {
    return null;
  }
}

/** Use a temporary title marker to find the Chrome tab ID for a CDP target. */
async function getChromeTabId(target: CdpTarget): Promise<number | null> {
  const marker = `bo-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const origTitle = target.title;
  try {
    await cdpEval(target.webSocketDebuggerUrl, `document.title = ${JSON.stringify(marker)}`);
    const chromeId = await evalInExt<number>(
      `chrome.tabs.query({title: ${JSON.stringify(marker)}}).then(tabs => tabs[0]?.id ?? -1)`,
    );
    // Best-effort title restore
    await cdpEval(target.webSocketDebuggerUrl, `document.title = ${JSON.stringify(origTitle)}`).catch(() => {});
    return chromeId === -1 ? null : chromeId;
  } catch {
    return null;
  }
}

// watchId → set of known tab IDs at watch-start time
const watches = new Map<string, Set<string>>();

function jsonResp(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

export function startHeliumApi(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${HELIUM_API_PORT}`);
    const method = req.method ?? 'GET';

    try {
      // ── GET /cdp/json[/*] ─────────────────────────────────────────────────
      // CDP proxy: forwards Chrome's /json endpoints to containers, rewriting
      // webSocketDebuggerUrl so they point back through this proxy instead of
      // directly to Chrome (which rejects non-localhost Host headers).
      if (method === 'GET' && url.pathname.startsWith('/cdp/json')) {
        const chromePath = url.pathname.replace('/cdp', '');
        const chromeRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}${chromePath}`);
        if (!chromeRes.ok) {
          jsonResp(res, chromeRes.status, { error: 'Chrome CDP error' });
          return;
        }
        const raw = await chromeRes.text();
        const rewritten = raw.replace(
          /ws:\/\/localhost:9222\/devtools\//g,
          `ws://host.docker.internal:${HELIUM_API_PORT}/cdp/devtools/`,
        );
        res.writeHead(chromeRes.status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(rewritten);
        return;

        // ── PUT /cdp/json/new ────────────────────────────────────────────────
      } else if (method === 'PUT' && url.pathname === '/cdp/json/new') {
        const chromeRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new`, { method: 'PUT' });
        const raw = await chromeRes.text();
        const rewritten = raw.replace(
          /ws:\/\/localhost:9222\/devtools\//g,
          `ws://host.docker.internal:${HELIUM_API_PORT}/cdp/devtools/`,
        );
        res.writeHead(chromeRes.status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(rewritten);
        return;

        // ── GET /helium/tabs ─────────────────────────────────────────────────
      } else if (method === 'GET' && url.pathname === '/helium/tabs') {
        const targets = (await listTargets()).filter((t) => t.type === 'page');
        jsonResp(res, 200, {
          tabs: targets.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        });

        // ── GET /helium/bo-tabs ───────────────────────────────────────────
      } else if (method === 'GET' && url.pathname === '/helium/bo-tabs') {
        const groupId = await getBoGroupId();
        if (groupId === null) {
          jsonResp(res, 200, { tabs: [] });
          return;
        }
        const raw = await evalInExt<string>(
          `chrome.tabs.query({groupId: ${groupId}}).then(t => JSON.stringify(t.map(x => ({url: x.url, title: x.title}))))`,
        );
        const chromeTabs = JSON.parse(raw) as Array<{
          url: string;
          title: string;
        }>;
        const targets = (await listTargets()).filter((t) => t.type === 'page');
        const result = chromeTabs.map((ct) => {
          const target = targets.find((t) => t.url === ct.url);
          return { ...ct, cdpTargetId: target?.id };
        });
        jsonResp(res, 200, { tabs: result });

        // ── GET /helium/is-bo-tab?targetId=<id> ──────────────────────────
      } else if (method === 'GET' && url.pathname === '/helium/is-bo-tab') {
        const targetId = url.searchParams.get('targetId');
        if (!targetId) {
          jsonResp(res, 400, { error: 'Missing targetId' });
          return;
        }
        const groupId = await getBoGroupId();
        if (groupId === null) {
          jsonResp(res, 200, { isBoTab: false });
          return;
        }
        const target = (await listTargets()).find((t) => t.id === targetId);
        if (!target) {
          jsonResp(res, 200, { isBoTab: false });
          return;
        }
        const raw = await evalInExt<string>(
          `chrome.tabs.query({groupId: ${groupId}}).then(t => JSON.stringify(t.map(x => x.url)))`,
        );
        const boUrls = JSON.parse(raw) as string[];
        jsonResp(res, 200, { isBoTab: boUrls.includes(target.url) });

        // ── POST /helium/create-tab ──────────────────────────────────────
        // Creates a blank tab in the Bo group. agent-browser will automatically
        // use this tab for the next --cdp session (it picks up the most recently
        // created blank tab).
      } else if (method === 'POST' && url.pathname === '/helium/create-tab') {
        const result = await createBoTab();
        if (result) {
          jsonResp(res, 200, result);
        } else {
          jsonResp(res, 503, {
            error: 'Could not create tab',
            hint: 'Is Helium running with --remote-debugging-port=9222?',
          });
        }

        // ── GET /helium/tab-content?targetId=<id> ────────────────────────
        // Non-destructive: reads any tab's content without navigating it.
      } else if (method === 'GET' && url.pathname === '/helium/tab-content') {
        const targetId = url.searchParams.get('targetId');
        if (!targetId) {
          jsonResp(res, 400, { error: 'Missing targetId' });
          return;
        }
        const content = await getTabContent(targetId);
        if (content) {
          jsonResp(res, 200, content);
        } else {
          jsonResp(res, 404, {
            error: 'Tab not found or not readable',
            targetId,
          });
        }

        // ── POST /helium/watch-start ──────────────────────────────────────
      } else if (method === 'POST' && url.pathname === '/helium/watch-start') {
        const targets = (await listTargets()).filter((t) => t.type === 'page');
        const watchId = `w-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        watches.set(watchId, new Set(targets.map((t) => t.id)));
        // Clean up stale watches after 10 minutes
        setTimeout(() => watches.delete(watchId), 10 * 60 * 1000);
        jsonResp(res, 200, { watchId, tabCount: targets.length });

        // ── POST /helium/watch-claim ──────────────────────────────────────
      } else if (method === 'POST' && url.pathname === '/helium/watch-claim') {
        const body = (await readBody(req)) as { watchId?: string };
        const snapshot = body.watchId ? watches.get(body.watchId) : null;
        if (!snapshot) {
          jsonResp(res, 400, { error: 'Invalid or expired watchId' });
          return;
        }
        watches.delete(body.watchId!);

        const current = (await listTargets()).filter((t) => t.type === 'page');
        const newTargets = current.filter((t) => !snapshot.has(t.id));

        if (newTargets.length === 0) {
          jsonResp(res, 200, { claimedTabs: [] });
          return;
        }

        const chromeIds: number[] = [];
        for (const target of newTargets) {
          const chromeId = await getChromeTabId(target);
          if (chromeId !== null) chromeIds.push(chromeId);
        }

        if (chromeIds.length > 0) {
          await moveTabsToBoGroup(chromeIds);
        }

        jsonResp(res, 200, {
          claimedTabs: newTargets.map((t) => ({
            cdpTargetId: t.id,
            url: t.url,
            title: t.title,
          })),
        });
        // ── POST /helium/restore-focus ────────────────────────────────────
        // Ensure the user's Helium window stays in front of Bo's window.
      } else if (method === 'POST' && url.pathname === '/helium/restore-focus') {
        try {
          // Find all windows and focus the one that isn't Bo's
          const boGroupId = await getBoGroupId();
          if (boGroupId !== null) {
            await evalInExt<void>(
              `(async () => {
                const boTabs = await chrome.tabs.query({groupId: ${boGroupId}});
                const boWindowId = boTabs[0]?.windowId;
                const allWindows = await chrome.windows.getAll();
                for (const w of allWindows) {
                  if (w.id !== boWindowId) {
                    await chrome.windows.update(w.id, {focused: true});
                    break;
                  }
                }
              })()`,
            );
          }
          jsonResp(res, 200, { status: 'ok' });
        } catch (err) {
          jsonResp(res, 200, {
            status: 'ok',
            note: 'best-effort',
          });
        }

        // ── GET /credentials/list ────────────────────────────────────────
      } else if (method === 'GET' && url.pathname === '/credentials/list') {
        try {
          const allowlist: CredentialAllowlist = JSON.parse(fs.readFileSync(CREDENTIAL_ALLOWLIST_PATH, 'utf-8'));
          const services = Object.entries(allowlist.services).map(([name, entry]) => ({
            service: name,
            fields: entry.fields,
          }));
          jsonResp(res, 200, { services });
        } catch (err) {
          jsonResp(res, 500, {
            error: 'Credential allowlist not found or invalid',
            detail: err instanceof Error ? err.message : String(err),
          });
        }

        // ── GET /credentials ─────────────────────────────────────────────
      } else if (method === 'GET' && url.pathname === '/credentials') {
        const service = url.searchParams.get('service');
        if (!service) {
          jsonResp(res, 400, { error: 'Missing ?service= parameter' });
          return;
        }
        const creds = getCredentials(service);
        if (!creds) {
          jsonResp(res, 404, {
            error: `No credentials found for service "${service}"`,
          });
          return;
        }
        logger.info({ service }, 'Credentials retrieved via 1Password');
        jsonResp(res, 200, { service, fields: creds });

        // /usage, /meetings, /tasks endpoints lived here in v1 but queried
        // v1-only tables (token_usage, meeting_briefs, suggested_tasks).
        // Dropped on the v2 port — would need v2-native equivalents to revive.

        // ── POST /send-file ──────────────────────────────────────────────────
        // Upload a local file to a Slack channel.
        // Body: { chatJid: "slack:CXXX", filePath: "/abs/path", filename?: "name.mp4", comment?: "msg" }
      } else if (method === 'POST' && url.pathname === '/send-file') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { chatJid, filePath, filename, comment } = JSON.parse(body) as {
          chatJid: string;
          filePath: string;
          filename?: string;
          comment?: string;
        };

        if (!chatJid || !filePath) {
          jsonResp(res, 400, { error: 'chatJid and filePath are required' });
          return;
        }
        if (!chatJid.startsWith('slack:')) {
          jsonResp(res, 400, { error: 'Only slack: JIDs are supported' });
          return;
        }

        const channelId = chatJid.replace(/^slack:/, '');
        const env = readEnvFile(['SLACK_BOT_TOKEN']);
        const token = env.SLACK_BOT_TOKEN;
        if (!token) {
          jsonResp(res, 503, { error: 'SLACK_BOT_TOKEN not set in .env' });
          return;
        }

        const fileBuffer = fs.readFileSync(filePath);
        const fname = filename || path.basename(filePath);
        const fileSize = fileBuffer.length;

        // Step 1: get upload URL
        const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            filename: fname,
            length: String(fileSize),
          }),
        });
        const urlData = (await urlRes.json()) as {
          ok: boolean;
          upload_url?: string;
          file_id?: string;
          error?: string;
        };
        if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
          jsonResp(res, 502, {
            error: urlData.error || 'Failed to get upload URL',
          });
          return;
        }

        // Step 2: upload binary
        await fetch(urlData.upload_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: fileBuffer,
        });

        // Step 3: complete upload and post to channel
        const completeBody: Record<string, string> = {
          files: JSON.stringify([{ id: urlData.file_id }]),
          channel_id: channelId,
        };
        if (comment) completeBody.initial_comment = comment;

        const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(completeBody),
        });
        const completeData = (await completeRes.json()) as {
          ok: boolean;
          files?: Array<{ permalink?: string }>;
          error?: string;
        };
        if (!completeData.ok) {
          jsonResp(res, 502, {
            error: completeData.error || 'Failed to complete upload',
          });
          return;
        }

        const permalink = completeData.files?.[0]?.permalink;
        logger.info({ chatJid, file: fname, permalink }, 'File uploaded to Slack');
        jsonResp(res, 200, { status: 'ok', permalink });
      } else {
        jsonResp(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, path: url.pathname }, 'Helium API error');
      jsonResp(res, 503, {
        error: msg,
        hint: 'Is Helium running with --remote-debugging-port=9222?',
      });
    }
  });

  // ── WebSocket proxy for /cdp/devtools/* ────────────────────────────────
  // Containers connect to ws://host.docker.internal:9224/cdp/devtools/page/<id>
  // and we pipe that to ws://localhost:9222/devtools/page/<id>, rewriting the
  // Host header so Chrome accepts the connection.
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/cdp/devtools/')) {
      socket.destroy();
      return;
    }
    const targetPath = req.url.replace('/cdp', '');
    const upstream = net.connect(CDP_PORT, CDP_HOST, () => {
      // Forward the upgrade request with Host: localhost so Chrome accepts it
      const headers = [
        `GET ${targetPath} HTTP/1.1`,
        `Host: localhost`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key'] ?? 'dGhlIHNhbXBsZSBub25jZQ=='}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] ?? '13'}`,
        '',
        '',
      ].join('\r\n');
      upstream.write(headers);
      if (head.length) upstream.write(head);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  server.listen(HELIUM_API_PORT, '0.0.0.0', () => {
    logger.info({ port: HELIUM_API_PORT }, 'Helium tab group API started');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port: HELIUM_API_PORT }, 'Helium API port already in use');
    } else {
      logger.warn({ err }, 'Helium API server error');
    }
  });

  return server;
}
