/**
 * bo-escalation-pause — structural fix for "Bo plows forward when Joel pushes back."
 *
 * When Joel sends a message that signals "you got it wrong, slow down" — repeated
 * "no", caps-lock yelling, name-calling, repeated correction of the same point —
 * we don't trust Bo to notice the signal himself. The CLAUDE.md instruction to
 * "pause and ask" was already there in spirit and Bo ignored it across 80+
 * messages. Models trained on conversational data default to generating; nothing
 * in their training rewards stopping.
 *
 * This plugin intercepts the inbound BEFORE the agent prompt is built, and
 * prepends a runtime directive into the message that:
 *   1. Names the failure pattern explicitly
 *   2. Forbids generating a new draft this turn
 *   3. Demands exactly one focused clarifying question
 *
 * The directive is structured so it can't be skimmed past — short, capitalized,
 * with explicit "STOP" wording. It does not replace Joel's actual message; it
 * augments it. The agent still sees what Joel said verbatim.
 *
 * Activation patterns (any match):
 *   - ≥3 capital letters in a row within a word longer than 3 letters
 *     (e.g. "STOP", "WHY", "ARE YOU AN IDIOT") — sustained caps, not a single
 *     acronym
 *   - "are you (an? )?(idiot|stupid|crazy|dumb)" — name-calling
 *   - "(?:?!|!?){2,}" — repeated punctuation (signals exasperation)
 *   - Bare "no" or "no," or "No." within the first 8 chars
 *   - "stop", "wrong again", "still wrong", "did the same thing"
 *   - Joel asked the same thing >=2 times in last 5 inbound messages (semantic
 *     repetition — implemented as length-bucketed Jaccard over recent inbound)
 */
import { registerInboundTransformer } from '../../extension-points.js';
import { openInboundDb } from '../../session-manager.js';
import { findSession, getSession } from '../../db/sessions.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';

interface InboundContent {
  text?: string;
}

interface PriorMessageRow {
  content: string;
}

const CAPS_RE = /\b[A-Z]{4,}\b/;
const NAMECALL_RE = /\bare you (?:an? )?(idiot|stupid|crazy|dumb|brain[ -]?dead)/i;
const EXASPERATION_RE = /[!?]{3,}/;
const HARD_NO_RE = /^\s*no[,.\s!?]/i;
const FAILURE_PHRASES =
  /\b(stop being|stop sending|wrong again|still wrong|did the same thing|you just did|you keep doing|how many times)\b/i;

function detectEscalation(text: string): { escalated: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (CAPS_RE.test(text)) reasons.push('caps-yelling');
  if (NAMECALL_RE.test(text)) reasons.push('name-calling');
  if (EXASPERATION_RE.test(text)) reasons.push('exasperation-punct');
  if (HARD_NO_RE.test(text)) reasons.push('hard-no-opening');
  if (FAILURE_PHRASES.test(text)) reasons.push('failure-phrase');
  return { escalated: reasons.length > 0, reasons };
}

// Cheap bag-of-tokens overlap so we can detect "Joel said the same thing again."
// Token-set Jaccard >= 0.55 over messages of similar length = treat as a repeat.
function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function findRecentRepeats(
  currentText: string,
  agentGroupId: string,
  sessionId: string,
): { repeats: number; sample?: string } {
  try {
    const inDb = openInboundDb(agentGroupId, sessionId);
    if (!inDb) return { repeats: 0 };
    try {
      const rows = inDb
        .prepare(
          `SELECT content FROM messages_in
           WHERE kind IN ('chat', 'chat-sdk')
           ORDER BY seq DESC LIMIT 6`,
        )
        .all() as PriorMessageRow[];
      const currentTokens = tokenize(currentText);
      if (currentTokens.size < 3) return { repeats: 0 };
      let repeats = 0;
      let sample: string | undefined;
      // skip rows[0] — it's the message we're currently transforming
      for (const r of rows.slice(1)) {
        let priorText = '';
        try {
          priorText = (JSON.parse(r.content) as InboundContent).text ?? '';
        } catch {
          continue;
        }
        if (!priorText) continue;
        const score = jaccard(currentTokens, tokenize(priorText));
        if (score >= 0.55) {
          repeats++;
          if (!sample) sample = priorText.slice(0, 80);
        }
      }
      return { repeats, sample };
    } finally {
      inDb.close();
    }
  } catch {
    return { repeats: 0 };
  }
}

const PAUSE_DIRECTIVE = `<system priority="critical">
Joel just pushed back on your previous response. Pattern detected: %REASONS%.

**Do NOT generate a new draft this turn.**

Instead, output exactly one short response:
1. Acknowledge specifically what you got wrong (quote the part of his message that signals it).
2. Ask ONE focused clarifying question about the actual ambiguity — not "what do you want?" but a concrete fork ("did you mean A or B?"), grounded in your current understanding.
3. If you previously sent a Slack message and have not yet called inspect_message on it, call inspect_message first so you know what actually rendered before asking.

Do not justify your previous attempt. Do not promise to try harder. Do not list everything you tried. Stop. Pause. Ask.
</system>

`;

export default async function init(): Promise<void> {
  registerInboundTransformer(async (event) => {
    if (event.message.kind !== 'chat-sdk' && event.message.kind !== 'chat') return event;

    let content: InboundContent;
    try {
      content = JSON.parse(event.message.content as unknown as string) as InboundContent;
    } catch {
      return event;
    }
    const text = content.text;
    if (!text || text.length < 2) return event;

    const { escalated, reasons } = detectEscalation(text);

    // Also count semantic repeats — needs the session id, which we look up
    // from the messaging-group + thread routing the same way router.ts does.
    let repeats = 0;
    let repeatSample: string | undefined;
    try {
      const mg = getMessagingGroupByPlatform(event.channelType, event.platformId);
      if (mg) {
        const existing = findSession(mg.id, event.threadId);
        if (existing) {
          const session = getSession(existing.id);
          if (session) {
            const r = findRecentRepeats(text, session.agent_group_id, session.id);
            repeats = r.repeats;
            repeatSample = r.sample;
          }
        }
      }
    } catch (err) {
      log.debug('bo-escalation-pause: repeat-check failed', { err });
    }

    const allReasons = [...reasons];
    if (repeats >= 1) allReasons.push(`repeated-correction (${repeats}x, e.g. "${repeatSample}")`);

    if (allReasons.length === 0) return event;

    log.info('bo-escalation-pause: directive injected', {
      sessionId: event.threadId,
      reasons: allReasons,
      textPreview: text.slice(0, 80),
    });

    // Prepend the directive into the text. Bo sees Joel's message verbatim
    // after the directive — we don't redact.
    const augmented = PAUSE_DIRECTIVE.replace('%REASONS%', allReasons.join(', ')) + text;
    const newContent = JSON.stringify({ ...content, text: augmented });
    return {
      ...event,
      message: {
        ...event.message,
        content: newContent as unknown as typeof event.message.content,
      },
    };
  });

  log.info('bo-escalation-pause: registered');
}
