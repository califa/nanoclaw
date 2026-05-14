/**
 * Extension points for plugins.
 *
 * Plugins register transformers/handlers via these registries at load time.
 * The host calls them at well-defined points (router, delivery, scheduler).
 *
 * Stable surface — plugins consume these from a long-lived sibling branch
 * (e.g. `bo-features`) so upstream merges don't conflict with feature code.
 */
import type { InboundEvent } from './channels/adapter.js';
import { log } from './log.js';

// ─── Inbound transformers ─────────────────────────────────────────────────────
// Run on every InboundEvent before routeInbound() does anything else.
// Return:
//   - the (possibly mutated) event to continue routing
//   - null to drop the event silently
//
// Order: registration order. Each transformer sees the output of the previous.
// A throw is logged and treated as "no transformation" (event passes through unchanged).

export type InboundTransformer = (event: InboundEvent) => Promise<InboundEvent | null>;

const inboundTransformers: InboundTransformer[] = [];

export function registerInboundTransformer(t: InboundTransformer): void {
  inboundTransformers.push(t);
}

export async function runInboundTransformers(event: InboundEvent): Promise<InboundEvent | null> {
  let current: InboundEvent | null = event;
  for (const t of inboundTransformers) {
    if (current === null) return null;
    try {
      current = await t(current);
    } catch (err) {
      log.warn('inbound transformer threw', { err });
    }
  }
  return current;
}

// ─── Outbound transformers ────────────────────────────────────────────────────
// Run on every outbound message before it's written to outbound.db.
// Same drop / mutate / passthrough semantics as inbound.

export interface OutboundMessageShape {
  sessionId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  content: string;
  // Implementations may add more fields; transformers should preserve unknown keys.
  [k: string]: unknown;
}

export type OutboundTransformer = (msg: OutboundMessageShape) => Promise<OutboundMessageShape | null>;

const outboundTransformers: OutboundTransformer[] = [];

export function registerOutboundTransformer(t: OutboundTransformer): void {
  outboundTransformers.push(t);
}

export async function runOutboundTransformers(msg: OutboundMessageShape): Promise<OutboundMessageShape | null> {
  let current: OutboundMessageShape | null = msg;
  for (const t of outboundTransformers) {
    if (current === null) return null;
    try {
      current = await t(current);
    } catch (err) {
      log.warn('outbound transformer threw', { err });
    }
  }
  return current;
}

// ─── Scheduler signal handlers ────────────────────────────────────────────────
// Plugins register handlers for tag-style signals embedded in agent output
// (e.g. <retry reason="..."/>). The scheduler dispatches each matching tag
// to its handler after the host parses the outbound message.

export interface SchedulerSignal {
  kind: string;
  attributes: Record<string, string>;
  body: string;
}

export interface SignalContext {
  sessionId: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  taskId: string | null;
}

export type SignalHandler = (signal: SchedulerSignal, ctx: SignalContext) => Promise<void>;

const signalHandlers = new Map<string, SignalHandler>();

export function registerSignalHandler(kind: string, h: SignalHandler): void {
  signalHandlers.set(kind, h);
}

export async function dispatchSignal(signal: SchedulerSignal, ctx: SignalContext): Promise<void> {
  const handler = signalHandlers.get(signal.kind);
  if (!handler) return;
  try {
    await handler(signal, ctx);
  } catch (err) {
    log.warn('signal handler threw', { kind: signal.kind, err });
  }
}

/**
 * Parse `<kind attr="val">body</kind>` and `<kind attr="val" />` from text.
 * Returns each tag plus the text with all matches stripped.
 *
 * Permissive on whitespace and self-closing form. Doesn't recurse into nested
 * tags — the agent prompts won't produce nested scheduler tags in practice.
 */
export function parseSchedulerSignals(text: string): { signals: SchedulerSignal[]; stripped: string } {
  const signals: SchedulerSignal[] = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/\1>)/g;
  let stripped = text;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const kind = m[1];
    const attrText = m[2] ?? '';
    const body = m[3] ?? '';
    if (!signalHandlers.has(kind)) continue; // not a known signal — leave in text
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrText)) !== null) {
      attrs[am[1]] = am[2];
    }
    signals.push({ kind, attributes: attrs, body: body.trim() });
    stripped = stripped.replace(m[0], '');
  }
  return { signals, stripped };
}
