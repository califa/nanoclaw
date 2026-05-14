/**
 * bo-reviewer-enforcement — host-side outbound transformer that gates
 * Slack outbound on Bo having run the adversarial reviewer.
 *
 * The `bo-adversarial-reviewer` container skill tells Bo to invoke the
 * critic and emit a `<reviewer-ok />` tag in the same outbound. This
 * transformer scans qualifying Slack outbound for the tag and:
 *
 *   - If present: strips the tag, lets the message through.
 *   - If missing AND message qualifies: blocks delivery, replaces content
 *     with an internal note so Joel sees the skip (and so it shows in
 *     Slack logs as a deliberate block).
 *
 * Qualifying criteria mirror the skill:
 *   - channel_type === 'slack'
 *   - kind === 'chat' (not system/ask_question)
 *   - content text length >= 50 chars OR contains a person-claim pattern
 *
 * The agent's bypass for proactive acks is honored by the skill itself
 * (Bo calls `mcp__nanoclaw__send_message` for those, which often have
 * different content shapes). We also skip when content text is short
 * enough that the reviewer would be wasted overhead.
 */
import { registerOutboundTransformer } from '../../extension-points.js';
import { log } from '../../log.js';

const REVIEWER_TAG_RE = /<reviewer-ok\s*\/>/i;
// Rough heuristic for "claims something about a specific person": a capitalized
// name followed by a verb. Not airtight; intentionally trigger-happy so the
// reviewer gets called when in doubt.
const PERSON_CLAIM_RE = /\b[A-Z][a-z]+\s+(is|was|will|did|said|leads?|owns?|runs?|reports?|joined|left)\b/;
const MIN_LEN_FOR_REVIEW = 50;

interface ContentShape {
  text?: string;
  type?: string;
}

function shouldEnforce(msg: { kind?: string; channelType?: string; content?: string }): boolean {
  if (msg.channelType !== 'slack') return false;
  if (msg.kind !== 'chat') return false;
  let parsed: ContentShape | null = null;
  try {
    parsed = JSON.parse(msg.content ?? '');
  } catch {
    return false;
  }
  // Bo's proactive ack tool uses a different shape (no text). Skip those.
  if (!parsed || typeof parsed.text !== 'string') return false;
  const text = parsed.text;
  if (text.length < MIN_LEN_FOR_REVIEW && !PERSON_CLAIM_RE.test(text)) return false;
  return true;
}

export default async function init(): Promise<void> {
  registerOutboundTransformer(async (msg) => {
    if (!shouldEnforce(msg)) return msg;

    let parsed: ContentShape;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      return msg;
    }
    const text = parsed.text ?? '';

    if (REVIEWER_TAG_RE.test(text)) {
      // Strip the tag so it doesn't appear in Slack
      parsed.text = text.replace(REVIEWER_TAG_RE, '').trim();
      return { ...msg, content: JSON.stringify(parsed) };
    }

    // Reviewer not invoked — block by mutating the message into a soft warning.
    // Don't drop entirely; let Joel see something landed but the gate fired.
    log.warn('bo-reviewer-enforcement: blocked unreviewed Slack outbound', {
      sessionId: msg.sessionId,
      chars: text.length,
    });
    parsed.text = `:warning: [reviewer-enforcement blocked this message — Bo did not invoke the adversarial reviewer before sending. Original length: ${text.length} chars. See bo-adversarial-reviewer skill.]`;
    return { ...msg, content: JSON.stringify(parsed) };
  });

  log.info('bo-reviewer-enforcement: outbound gate registered for Slack');
}
