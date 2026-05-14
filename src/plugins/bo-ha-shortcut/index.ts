/**
 * bo-ha-shortcut — fast path for Home Assistant commands.
 *
 * Intercepts inbound messages that look like simple HA commands ("turn on
 * the kitchen lights", "is the front door locked", etc.) and executes them
 * directly via the HA REST API before they reach the container. Reply is
 * written straight into the session's outbound.db so delivery picks it up
 * without spawning a container. Sub-second response on common smart home
 * actions.
 *
 * Falls through (returns event unchanged) for anything it can't match —
 * the normal Claude pipeline handles those.
 *
 * Ported from v1's src/ha-shortcut.ts (commit ae5d650).
 */
import { registerInboundTransformer } from '../../extension-points.js';
import { readEnvFile } from '../../env.js';
import { writeOutboundDirect } from '../../session-manager.js';
import { getSession, findSession } from '../../db/sessions.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';

const env = readEnvFile(['HASS_TOKEN', 'HASS_URL']);
const HASS_TOKEN = env.HASS_TOKEN;
const HASS_URL = env.HASS_URL || 'http://host.docker.internal:8123';
// HA is on host; from host's own process use localhost, not docker bridge.
const HASS_HOST_URL = HASS_URL.replace('host.docker.internal', 'localhost');

interface HassEntity {
  entity_id: string;
  state: string;
  friendly_name: string;
  domain: string;
}

let entityCache: HassEntity[] = [];
let lastCacheTime = 0;
const CACHE_TTL = 60_000;

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
    log.debug('bo-ha-shortcut: entity cache refresh failed');
  }
}

async function callService(domain: string, service: string, entityId?: string): Promise<boolean> {
  if (!HASS_TOKEN) return false;
  try {
    const body = entityId ? JSON.stringify({ entity_id: entityId }) : '{}';
    const res = await fetch(`${HASS_HOST_URL}/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HASS_TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Match common command shapes. Keep narrow — false positives invoke services.
const ON_OFF_RE = /^(?:please\s+|can\s+you\s+)?(turn|switch)\s+(on|off)\s+(?:the\s+)?(.+?)[.?!]?$/i;
const TOGGLE_RE = /^(?:please\s+|can\s+you\s+)?toggle\s+(?:the\s+)?(.+?)[.?!]?$/i;
const STATE_RE = /^(?:what(?:'s|\s+is)|is)\s+(?:the\s+)?(.+?)(?:\s+(?:on|off|status|state|locked|unlocked))?[.?!]?$/i;

function findEntity(query: string): HassEntity | null {
  const q = query.toLowerCase().trim();
  // Exact friendly_name match first
  let match = entityCache.find((e) => e.friendly_name.toLowerCase() === q);
  if (match) return match;
  // Substring on friendly_name
  match = entityCache.find((e) => e.friendly_name.toLowerCase().includes(q));
  if (match) return match;
  // Entity_id includes query
  match = entityCache.find((e) => e.entity_id.toLowerCase().includes(q.replace(/\s+/g, '_')));
  return match ?? null;
}

interface MatchResult {
  reply: string;
}

async function tryMatch(text: string): Promise<MatchResult | null> {
  if (!HASS_TOKEN) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  await refreshEntities();
  if (entityCache.length === 0) return null;

  const onOff = ON_OFF_RE.exec(trimmed);
  if (onOff) {
    const action = onOff[2].toLowerCase();
    const entity = findEntity(onOff[3]);
    if (!entity) return { reply: `Couldn't find a Home Assistant entity matching "${onOff[3]}".` };
    if (!['light', 'switch', 'fan', 'media_player', 'input_boolean', 'automation'].includes(entity.domain)) {
      return null; // not safe to control via shortcut
    }
    const ok = await callService(entity.domain, `turn_${action}`, entity.entity_id);
    return { reply: ok ? `Turned ${action}: ${entity.friendly_name}` : `Couldn't ${action} ${entity.friendly_name}.` };
  }

  const tog = TOGGLE_RE.exec(trimmed);
  if (tog) {
    const entity = findEntity(tog[1]);
    if (!entity) return { reply: `Couldn't find a Home Assistant entity matching "${tog[1]}".` };
    if (!['light', 'switch', 'fan', 'media_player', 'input_boolean'].includes(entity.domain)) return null;
    const ok = await callService(entity.domain, 'toggle', entity.entity_id);
    return { reply: ok ? `Toggled: ${entity.friendly_name}` : `Couldn't toggle ${entity.friendly_name}.` };
  }

  const state = STATE_RE.exec(trimmed);
  if (state) {
    const entity = findEntity(state[1]);
    if (!entity) return null; // ambiguous — let Claude handle
    return { reply: `${entity.friendly_name}: ${entity.state}` };
  }

  return null;
}

interface InboundContent {
  text?: string;
}

export default async function init(): Promise<void> {
  if (!HASS_TOKEN) {
    log.debug('bo-ha-shortcut: HASS_TOKEN not set, shortcut disabled');
    return;
  }

  registerInboundTransformer(async (event) => {
    // Only intercept on chat-sdk channels (slack/telegram/whatsapp/etc.).
    // Skip system/task/agent-routed messages.
    if (event.message.kind !== 'chat-sdk' && event.message.kind !== 'chat') return event;

    let content: InboundContent;
    try {
      content = JSON.parse(event.message.content as unknown as string) as InboundContent;
    } catch {
      return event;
    }
    if (!content.text) return event;

    let result: MatchResult | null;
    try {
      result = await tryMatch(content.text);
    } catch (err) {
      log.warn('bo-ha-shortcut: match failed', { err });
      return event;
    }
    if (!result) return event;

    // We have a fast-path reply. Find the session this would have routed
    // to and write the response directly. Return null to suppress Claude.
    try {
      const mg = getMessagingGroupByPlatform(event.channelType, event.platformId);
      if (!mg) return event;
      const existing = findSession(mg.id, event.threadId);
      if (!existing) {
        // No session yet — skip shortcut for first messages so we don't
        // have to create a session here; user's first interaction goes
        // through Claude.
        return event;
      }
      const session = getSession(existing.id);
      if (!session) return event;

      const replyContent = JSON.stringify({ text: result.reply, type: 'text' });
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `ha-shortcut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: event.platformId,
        channelType: event.channelType,
        threadId: event.threadId,
        content: replyContent,
      });
      log.info('bo-ha-shortcut: intercepted HA command', {
        text: content.text.slice(0, 60),
        reply: result.reply.slice(0, 60),
      });
      return null; // suppress original inbound (don't wake container)
    } catch (err) {
      log.warn('bo-ha-shortcut: outbound write failed, falling through', { err });
      return event;
    }
  });

  log.info('bo-ha-shortcut: registered');
}
