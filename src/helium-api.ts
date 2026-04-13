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
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

import { logger } from './logger.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
export const HELIUM_API_PORT = 9224;
const CLAUDE_EXT_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const BO_GROUP_COLOR = 'cyan';

const CREDENTIAL_ALLOWLIST_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'credential-allowlist.json',
);

interface CredentialAllowlist {
  vault: string;
  services: Record<string, { item: string; fields: string[] }>;
}

const OP_PATH = '/opt/homebrew/bin/op';

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
      const env = { ...process.env };
      const opToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
      if (opToken) env.OP_SERVICE_ACCOUNT_TOKEN = opToken;

      if (field === 'one-time password') {
        const value = execFileSync(
          OP_PATH,
          ['item', 'get', entry.item, '--vault', allowlist.vault, '--otp'],
          { timeout: 10000, env },
        )
          .toString()
          .trim();
        result['otp'] = value;
      } else {
        const value = execFileSync(
          OP_PATH,
          [
            'item',
            'get',
            entry.item,
            '--vault',
            allowlist.vault,
            '--fields',
            field,
            '--reveal',
          ],
          { timeout: 10000, env },
        )
          .toString()
          .trim();
        result[field] = value;
      }
    } catch (err) {
      logger.warn(
        { err, service, field },
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

async function cdpEval(
  wsUrl: string,
  expression: string,
  awaitPromise = false,
): Promise<unknown> {
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

    const timer = setTimeout(
      () => finish(() => reject(new Error('CDP timeout'))),
      5000,
    );

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

    ws.addEventListener('error', () =>
      finish(() => reject(new Error('WebSocket error'))),
    );
  });
}

async function getExtSw(): Promise<CdpTarget | null> {
  const targets = await listTargets();
  return (
    targets.find(
      (t) => t.type === 'service_worker' && t.url.includes(CLAUDE_EXT_ID),
    ) ?? null
  );
}

async function evalInExt<T>(expression: string): Promise<T> {
  const sw = await getExtSw();
  if (!sw) throw new Error('Claude extension service worker not found in CDP');
  return cdpEval(sw.webSocketDebuggerUrl, expression, true) as Promise<T>;
}

async function getBoGroupId(): Promise<number | null> {
  const raw = await evalInExt<string>(
    'chrome.tabGroups.query({title: "Bo"}).then(g => JSON.stringify(g))',
  );
  const groups = JSON.parse(raw) as Array<{ id: number }>;
  return groups[0]?.id ?? null;
}

async function moveTabsToBoGroup(chromeTabIds: number[]): Promise<void> {
  if (chromeTabIds.length === 0) return;
  let groupId = await getBoGroupId();
  const ids = [...chromeTabIds];

  if (groupId === null) {
    const first = ids.shift()!;
    groupId = await evalInExt<number>(
      `chrome.tabs.group({tabIds: [${first}]}).then(id => id)`,
    );
    await evalInExt<void>(
      `chrome.tabGroups.update(${groupId}, {title: "Bo", color: "${BO_GROUP_COLOR}"})`,
    );
  }

  if (ids.length > 0) {
    await evalInExt<void>(
      `chrome.tabs.group({tabIds: ${JSON.stringify(ids)}, groupId: ${groupId}})`,
    );
  }
}

/**
 * Create a blank tab in Helium, move it to the Bo group, and return its CDP info.
 * agent-browser will use this blank tab when it runs next (it picks up the most
 * recently created/focused blank tab).
 */
async function createBoTab(): Promise<{
  cdpTargetId: string;
  wsUrl: string;
} | null> {
  // Create blank tab in the Bo group's window (background, no focus steal)
  let newTarget: CdpTarget;
  try {
    // Find the window that contains the Bo tab group
    const boGroupId = await getBoGroupId();
    let windowId: number | null = null;
    if (boGroupId !== null) {
      windowId = await evalInExt<number | null>(
        `chrome.tabs.query({groupId: ${boGroupId}}).then(tabs => tabs[0]?.windowId ?? null)`,
      );
    }
    // Create the tab in that specific window (or fallback to default)
    const createOpts = windowId
      ? `{active: false, url: 'about:blank', windowId: ${windowId}}`
      : `{active: false, url: 'about:blank'}`;
    const chromeTabId = await evalInExt<number>(
      `chrome.tabs.create(${createOpts}).then(t => t.id)`,
    );

    // Wait briefly for CDP to register the new tab
    await new Promise((r) => setTimeout(r, 500));

    // Find the CDP target for this Chrome tab
    const targets = await listTargets();
    const match = targets.find(
      (t) => t.type === 'page' && t.url === 'about:blank',
    );
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
    logger.warn(
      { targetId: newTarget.id },
      'Could not get Chrome tab ID for new tab',
    );
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
    const title = (await cdpEval(
      target.webSocketDebuggerUrl,
      'document.title',
    )) as string;
    const url = (await cdpEval(
      target.webSocketDebuggerUrl,
      'location.href',
    )) as string;
    const text = (await cdpEval(
      target.webSocketDebuggerUrl,
      'document.body?.innerText ?? ""',
    )) as string;
    const html = (await cdpEval(
      target.webSocketDebuggerUrl,
      'document.documentElement.outerHTML',
    )) as string;
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
    await cdpEval(
      target.webSocketDebuggerUrl,
      `document.title = ${JSON.stringify(marker)}`,
    );
    const chromeId = await evalInExt<number>(
      `chrome.tabs.query({title: ${JSON.stringify(marker)}}).then(tabs => tabs[0]?.id ?? -1)`,
    );
    // Best-effort title restore
    await cdpEval(
      target.webSocketDebuggerUrl,
      `document.title = ${JSON.stringify(origTitle)}`,
    ).catch(() => {});
    return chromeId === -1 ? null : chromeId;
  } catch {
    return null;
  }
}

// watchId → set of known tab IDs at watch-start time
const watches = new Map<string, Set<string>>();

function jsonResp(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
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
      // ── GET /helium/tabs ─────────────────────────────────────────────────
      if (method === 'GET' && url.pathname === '/helium/tabs') {
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
        // Agent-browser activates tabs when connecting via CDP. Bo should call
        // this after finishing browser work to give focus back to the user.
      } else if (
        method === 'POST' &&
        url.pathname === '/helium/restore-focus'
      ) {
        try {
          // Find the most recently active non-Bo tab
          const boGroupId = await getBoGroupId();
          const activeTab = await evalInExt<number | null>(
            `chrome.tabs.query({active: true, lastFocusedWindow: true}).then(tabs => {
              const t = tabs[0];
              return t ? t.id : null;
            })`,
          );
          if (activeTab !== null && boGroupId !== null) {
            // Check if the active tab is a Bo tab — if so, find the user's last tab
            const isBoTab = await evalInExt<boolean>(
              `chrome.tabs.get(${activeTab}).then(t => t.groupId === ${boGroupId})`,
            );
            if (isBoTab) {
              // Activate the most recent non-Bo tab
              await evalInExt<void>(
                `chrome.tabs.query({lastFocusedWindow: true}).then(tabs => {
                  const nonBo = tabs.find(t => t.groupId !== ${boGroupId} && !t.active);
                  if (nonBo) chrome.tabs.update(nonBo.id, {active: true});
                })`,
              );
            }
          }
          jsonResp(res, 200, { status: 'ok' });
        } catch (err) {
          jsonResp(res, 200, {
            status: 'ok',
            note: 'best-effort',
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

        // ── GET /usage ───────────────────────────────────────────────────
      } else if (method === 'GET' && url.pathname === '/usage') {
        const { getTokenUsageSummary } = await import('./db.js');
        const period = url.searchParams.get('period') || '24h';
        const since = new Date(
          Date.now() -
            (period === '7d'
              ? 7 * 86400000
              : period === '30d'
                ? 30 * 86400000
                : 86400000),
        ).toISOString();
        const summary = getTokenUsageSummary(since);
        jsonResp(res, 200, { period, since, ...summary });

        // ── GET /meetings ────────────────────────────────────────────────
      } else if (method === 'GET' && url.pathname === '/meetings') {
        const { getMeetingBriefs } = await import('./db.js');
        const date = url.searchParams.get('date') || undefined;
        const days = url.searchParams.get('days')
          ? parseInt(url.searchParams.get('days')!, 10)
          : undefined;
        const briefs = getMeetingBriefs(date, days);
        jsonResp(res, 200, {
          date: date || `next ${days || 7} days`,
          count: briefs.length,
          meetings: briefs.map((b) => ({
            ...b,
            attendees: b.attendees ? JSON.parse(b.attendees) : [],
            open_items: b.open_items ? JSON.parse(b.open_items) : [],
          })),
        });

        // ── GET /tasks ────────────────────────────────────────────────────
      } else if (method === 'GET' && url.pathname === '/tasks') {
        const { getSuggestedTasks } = await import('./db.js');
        const status = url.searchParams.get('status') || undefined;
        const tasks = getSuggestedTasks(status);
        jsonResp(res, 200, {
          count: tasks.length,
          tasks: tasks.map((t) => ({
            ...t,
            suggested_actions: t.suggested_actions
              ? JSON.parse(t.suggested_actions)
              : [],
          })),
        });

        // ── POST /tasks ────────────────────────────────────────────────
      } else if (method === 'POST' && url.pathname === '/tasks') {
        const { createSuggestedTask } = await import('./db.js');
        let body = '';
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body);
        const id = createSuggestedTask(data);
        jsonResp(res, 200, { status: 'ok', id });

        // ── PATCH /tasks/:id ───────────────────────────────────────────
      } else if (method === 'PATCH' && url.pathname.startsWith('/tasks/')) {
        const { updateSuggestedTask } = await import('./db.js');
        const id = parseInt(url.pathname.split('/')[2], 10);
        let body = '';
        for await (const chunk of req) body += chunk;
        const updates = JSON.parse(body);
        updateSuggestedTask(id, updates);
        jsonResp(res, 200, { status: 'ok', id });

        // ── POST /meetings ───────────────────────────────────────────────
      } else if (method === 'POST' && url.pathname === '/meetings') {
        const { upsertMeetingBrief } = await import('./db.js');
        let body = '';
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body);
        upsertMeetingBrief(data);
        jsonResp(res, 200, { status: 'ok', event_id: data.event_id });
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
