/**
 * Home Assistant Shortcut Handler
 *
 * Intercepts simple HA commands from messages and executes them directly
 * via the HA REST API, bypassing the full Claude pipeline for sub-second
 * response times on common smart home actions.
 *
 * Falls through to the normal agent pipeline for anything it can't handle.
 */

import { HASS_TOKEN, HASS_URL } from './config.js';
import { logger } from './logger.js';

const HASS_HOST_URL =
  HASS_URL?.replace('host.docker.internal', 'localhost') ||
  'http://localhost:8123';

interface HassEntity {
  entity_id: string;
  state: string;
  friendly_name: string;
  domain: string;
}

let entityCache: HassEntity[] = [];
let lastCacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

async function refreshEntities(): Promise<void> {
  if (!HASS_TOKEN) return;
  if (Date.now() - lastCacheTime < CACHE_TTL && entityCache.length > 0) return;

  try {
    const res = await fetch(`${HASS_HOST_URL}/api/states`, {
      headers: { Authorization: `Bearer ${HASS_TOKEN}` },
    });
    if (!res.ok) return;
    const states = (await res.json()) as Array<{
      entity_id: string;
      state: string;
      attributes: { friendly_name?: string };
    }>;
    entityCache = states.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      friendly_name: s.attributes.friendly_name || s.entity_id,
      domain: s.entity_id.split('.')[0],
    }));
    lastCacheTime = Date.now();
  } catch {
    logger.debug('HA entity cache refresh failed');
  }
}

async function callService(
  domain: string,
  service: string,
  entityId?: string,
): Promise<boolean> {
  try {
    const body: Record<string, string> = {};
    if (entityId) body.entity_id = entityId;
    const res = await fetch(
      `${HASS_HOST_URL}/api/services/${domain}/${service}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HASS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function findEntity(query: string, domains?: string[]): HassEntity | undefined {
  const q = query.toLowerCase().trim();
  // Strip trailing "light(s)" / "switch" / "fan" — users say "office lights"
  // but entity is "Joel Office Office"
  const qClean = q.replace(/\s*(lights?|switch(?:es)?|fans?)\s*$/i, '').trim();
  const candidates = domains
    ? entityCache.filter((e) => domains.includes(e.domain))
    : entityCache;

  // Exact friendly name match
  for (const query of [q, qClean]) {
    if (!query) continue;
    const exact = candidates.find(
      (e) => e.friendly_name.toLowerCase() === query,
    );
    if (exact) return exact;
  }

  // Contains match (both directions)
  for (const query of [q, qClean]) {
    if (!query) continue;
    const contains = candidates.find(
      (e) =>
        e.friendly_name.toLowerCase().includes(query) ||
        query.includes(e.friendly_name.toLowerCase()),
    );
    if (contains) return contains;
  }

  // Word overlap: all words in query appear in entity name or id
  for (const query of [q, qClean]) {
    if (!query) continue;
    const words = query.split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) continue;
    const match = candidates.find((e) => {
      const haystack =
        e.friendly_name.toLowerCase() +
        ' ' +
        e.entity_id.replace(/[._]/g, ' ').toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
    if (match) return match;
  }

  return undefined;
}

/**
 * Try to handle a message as an HA shortcut.
 * Returns the response text if handled, or null to fall through to the agent.
 */
export async function tryHaShortcut(message: string): Promise<string | null> {
  if (!HASS_TOKEN) return null;
  await refreshEntities();
  if (entityCache.length === 0) return null;

  const msg = message.toLowerCase().trim();

  // ── "lights on/off" (all lights) — check BEFORE individual on/off ─
  if (
    /^(?:all\s+)?lights?\s+(on|off)$/.test(msg) ||
    /^(on|off)\s+(?:all\s+)?lights?$/.test(msg)
  ) {
    const action = msg.includes('off') ? 'turn_off' : 'turn_on';
    const ok = await callService('light', action, 'all');
    return ok
      ? `All lights turned ${msg.includes('off') ? 'off' : 'on'}`
      : 'Failed to control lights';
  }

  // ── AC / climate — check BEFORE generic on/off ────────────────────
  const acMatch = msg.match(
    /^(?:turn\s+)?(?:the\s+)?(?:ac|air\s*con(?:ditioning)?|climate|hvac)\s+(on|off)$|^(on|off)\s+(?:the\s+)?(?:ac|air\s*con(?:ditioning)?|climate|hvac)$/,
  );
  if (acMatch) {
    const action = acMatch[1] || acMatch[2];
    const entity =
      findEntity('ac', ['climate']) ||
      entityCache.find((e) => e.domain === 'climate');
    if (entity) {
      const ok = await callService(
        'climate',
        action === 'on' ? 'turn_on' : 'turn_off',
        entity.entity_id,
      );
      return ok ? `AC turned ${action}` : 'Failed to control AC';
    }
  }

  // ── Turn on/off patterns ──────────────────────────────────────────
  const onOffMatch = msg.match(
    /^(?:turn\s+)?(on|off)\s+(?:the\s+)?(.+)$|^(?:turn\s+)?(?:the\s+)?(.+?)\s+(on|off)$/,
  );
  if (onOffMatch) {
    const action = onOffMatch[1] || onOffMatch[4];
    const target = (onOffMatch[2] || onOffMatch[3]).trim();
    const entity = findEntity(target, ['light', 'switch', 'fan']);
    if (entity) {
      const service = action === 'on' ? 'turn_on' : 'turn_off';
      const ok = await callService(entity.domain, service, entity.entity_id);
      return ok
        ? `${entity.friendly_name} turned ${action}`
        : `Failed to turn ${action} ${entity.friendly_name}`;
    }
  }

  // ── Scene activation ──────────────────────────────────────────────
  const sceneMatch = msg.match(
    /^(?:activate|set|run|start)\s+(?:the\s+)?(?:scene\s+)?(.+?)(?:\s+scene)?$/,
  );
  if (sceneMatch) {
    const entity = findEntity(sceneMatch[1], ['scene']);
    if (entity) {
      const ok = await callService('scene', 'turn_on', entity.entity_id);
      return ok
        ? `Scene "${entity.friendly_name}" activated`
        : `Failed to activate ${entity.friendly_name}`;
    }
  }

  // ── Open/close cover ──────────────────────────────────────────────
  const coverMatch = msg.match(/^(open|close)\s+(?:the\s+)?(.+)$/);
  if (coverMatch) {
    const entity = findEntity(coverMatch[2], ['cover']);
    if (entity) {
      const service = coverMatch[1] === 'open' ? 'open_cover' : 'close_cover';
      const ok = await callService('cover', service, entity.entity_id);
      return ok
        ? `${entity.friendly_name} ${coverMatch[1]}ed`
        : `Failed to ${coverMatch[1]} ${entity.friendly_name}`;
    }
  }

  // ── Status query ──────────────────────────────────────────────────
  const statusMatch = msg.match(
    /^(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:on|off|open|closed)\??$/,
  );
  if (statusMatch) {
    const entity = findEntity(statusMatch[1]);
    if (entity) {
      return `${entity.friendly_name} is ${entity.state}`;
    }
  }

  return null;
}
