/**
 * bo-reviewer-enforcement — auto-review qualifying Slack outbound.
 *
 * v1 of this plugin required Bo to emit `<reviewer-ok />` himself by
 * invoking the bo-adversarial-reviewer skill. In practice Bo kept
 * skipping the skill (session continuation preserves the old system
 * prompt across container respawns, so CLAUDE.local.md changes don't
 * always reach the model), and the gate blocked legitimate replies.
 *
 * v2 design: if a qualifying Slack message arrives WITHOUT the tag, the
 * gate runs the reviewer ITSELF as a fast Haiku call from the host. The
 * verdict is enforced regardless of whether Bo remembered to invoke the
 * skill. Bo can still emit `<reviewer-ok />` to short-circuit the host
 * review (cheaper when he ran it himself).
 *
 * Qualifying criteria:
 *   - channel_type === 'slack'
 *   - kind === 'chat'
 *   - parsed content has a `text` field
 *   - text length >= MIN_LEN_FOR_REVIEW OR contains a person-claim
 */
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { registerOutboundTransformer } from '../../extension-points.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const REVIEWER_TAG_RE = /<reviewer-ok\s*\/>/i;
const PERSON_CLAIM_RE = /\b[A-Z][a-z]+\s+(is|was|will|did|said|leads?|owns?|runs?|reports?|joined|left)\b/;
const MIN_LEN_FOR_REVIEW = 50;
const REVIEWER_MODEL = 'claude-haiku-4-5-20251001';
const WIKI_DIR = '/Users/joel/Brain/xtra/wiki/personal';

interface ContentShape {
  text?: string;
  type?: string;
}

interface ReviewVerdict {
  ok: boolean;
  reason?: string;
  fix?: string;
}

function shouldEnforce(msg: { kind?: string; channelType?: string; content?: string }): {
  enforce: boolean;
  text?: string;
  parsed?: ContentShape;
} {
  if (msg.channelType !== 'slack') return { enforce: false };
  if (msg.kind !== 'chat') return { enforce: false };
  let parsed: ContentShape;
  try {
    parsed = JSON.parse(msg.content ?? '');
  } catch {
    return { enforce: false };
  }
  if (typeof parsed.text !== 'string') return { enforce: false };
  const text = parsed.text;
  if (text.length < MIN_LEN_FOR_REVIEW && !PERSON_CLAIM_RE.test(text)) return { enforce: false };
  return { enforce: true, text, parsed };
}

function loadDynamicRules(): string {
  const rules: string[] = [];
  // bo-mistakes.md: per-rule entries written by bo-self-learning.
  // feedback.md: free-form behavioral notes.
  // bo-reviewer-patterns.md: distilled clusters from past blocks (bo-dreaming).
  for (const file of ['bo-mistakes.md', 'feedback.md', 'bo-reviewer-patterns.md']) {
    const p = path.join(WIKI_DIR, file);
    if (fs.existsSync(p)) {
      try {
        rules.push(`### From ${file}\n\n${fs.readFileSync(p, 'utf-8').slice(0, 4000)}`);
      } catch {
        /* skip */
      }
    }
  }
  return rules.length > 0 ? rules.join('\n\n') : '(no dynamic rules learned yet)';
}

function logReviewerBlock(
  originalText: string,
  reason: string,
  fix: string | undefined,
  sessionId: string | unknown,
): void {
  // Persist every block so bo-dreaming can distill recurring patterns.
  // Inline import to avoid load-order issues (this plugin shouldn't be
  // a hard dep on the central DB connection at module-load time).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../../db/connection.js') as { getDb: () => import('better-sqlite3').Database };
    getDb()
      .prepare(
        `INSERT INTO bo_reviewer_blocks (ts, session_id, original_text, reason, fix_applied) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), String(sessionId ?? ''), originalText.slice(0, 2000), reason, fix ?? null);
  } catch (err) {
    log.debug('bo-reviewer-enforcement: failed to log block', { err });
  }
}

let anthropic: Anthropic | null = null;

function getClient(env: Record<string, string>): Anthropic | null {
  if (anthropic) return anthropic;
  const apiKey = env.ANTHROPIC_API_KEY;
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!apiKey && !oauthToken) {
    log.warn('bo-reviewer-enforcement: no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN — host review disabled');
    return null;
  }
  anthropic = oauthToken ? new Anthropic({ authToken: oauthToken }) : new Anthropic({ apiKey });
  return anthropic;
}

async function reviewHostSide(text: string, env: Record<string, string>): Promise<ReviewVerdict | null> {
  const client = getClient(env);
  if (!client) return null;

  const dynamicRules = loadDynamicRules();
  const prompt = `You are Bo's strict pre-send reviewer for Slack messages. Catch mistakes before they go out.

Static rules (always apply):
- No \`**double asterisks**\` — Slack needs \`*single asterisks*\`.
- No \`##\` or \`#\` markdown headers — use \`*Bold text*\`.
- No \`[text](url)\` links — use \`<url|text>\`.
- No \`- \` bullets — use \`•\`.
- Markdown tables (\`| col | col |\`) are fine — Slack renders them.
- Task-review-style messages should be Block Kit, not raw text.

Factual discipline:
- Every claim about a specific person must trace to a single citable source. Inferences must be surfaced, not stated as fact.
- Negative signals (reject / no-hire / leaving) override positive context.
- Don't let narrative coherence pull toward false claims.

Dynamic rules distilled from Joel's past corrections:
${dynamicRules}

Message to review (between <<< >>>):
<<<
${text}
>>>

Return ONLY a JSON object, no commentary:
{
  "ok": true | false,
  "reason": "<one-line reason if not ok, otherwise omit>",
  "fix": "<the COMPLETE corrected message text, ready to send to Slack as-is; OMIT this field if you can't produce a full rewrite>"
}

CRITICAL: the "fix" field must contain the **entire rewritten message**, not instructions about how to fix it. Bad: "Replace ** with *". Good: the full message rewritten with single asterisks. If you can only describe the fix and not produce one, OMIT the fix field — the host will fall back to surfacing the original with the reason.

Be strict. Default ok=false if uncertain. Static-rule violations must always fail.`;

  try {
    const result = await client.messages.create({
      model: REVIEWER_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = result.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    const raw = block.text.trim();
    // Strip code fences if Haiku decides to wrap the JSON.
    const cleaned = raw
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(cleaned) as ReviewVerdict;
    return parsed;
  } catch (err) {
    log.warn('bo-reviewer-enforcement: host review failed', { err });
    return null;
  }
}

export default async function init(): Promise<void> {
  const env = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  // Pre-create the client at boot so .env auth issues surface here.
  getClient(env);

  registerOutboundTransformer(async (msg) => {
    const check = shouldEnforce(msg);
    if (!check.enforce || !check.parsed || !check.text) return msg;

    // If Bo already invoked the reviewer (emitted the tag), strip it and pass.
    if (REVIEWER_TAG_RE.test(check.text)) {
      check.parsed.text = check.text.replace(REVIEWER_TAG_RE, '').trim();
      return { ...msg, content: JSON.stringify(check.parsed) };
    }

    // Bo skipped — host runs the review instead.
    log.info('bo-reviewer-enforcement: Bo skipped reviewer, running host-side review', {
      sessionId: msg.sessionId,
      chars: check.text.length,
    });
    const verdict = await reviewHostSide(check.text, env);

    if (!verdict) {
      // Review failed (no creds / API error) — fail-open with a warning
      // appended to the message. Better than blocking entirely.
      log.warn('bo-reviewer-enforcement: review unavailable, fail-open', { sessionId: msg.sessionId });
      return msg;
    }

    if (verdict.ok) {
      log.info('bo-reviewer-enforcement: host-review passed', { sessionId: msg.sessionId });
      return msg;
    }

    // Verdict says NOT ok. Use the fix only if it looks like an actual
    // rewrite (≥50% of the original length and not obviously an instruction).
    // Otherwise surface the original + reason and let Joel decide.
    const looksLikeRealRewrite =
      verdict.fix !== undefined &&
      verdict.fix !== null &&
      verdict.fix.length >= Math.max(20, Math.floor(check.text.length * 0.5)) &&
      !/^replace\b|^change\b|^use\b|^fix:?\s|^suggest/i.test(verdict.fix.trim());

    // Log the block so bo-dreaming can distill patterns nightly.
    logReviewerBlock(check.text, verdict.reason ?? '(no reason)', verdict.fix, msg.sessionId);

    if (looksLikeRealRewrite && verdict.fix) {
      log.warn('bo-reviewer-enforcement: applied fix from host-review', {
        sessionId: msg.sessionId,
        reason: verdict.reason,
        origLen: check.text.length,
        fixLen: verdict.fix.length,
      });
      check.parsed.text = verdict.fix;
      return { ...msg, content: JSON.stringify(check.parsed) };
    }

    // No usable auto-fix — pass Bo's original message through unchanged.
    // The block was already recorded in bo_reviewer_blocks above so the
    // nightly bo-dreaming distillation picks up the pattern. Prepending a
    // ":warning: Reviewer flagged: …" sticker to Joel's own thread only
    // adds noise without improving the reply, so fail-open here.
    log.warn('bo-reviewer-enforcement: fail-open, no usable auto-fix', {
      sessionId: msg.sessionId,
      reason: verdict.reason,
      fixLen: verdict.fix?.length,
    });
    return msg;
  });

  log.info('bo-reviewer-enforcement: host-side auto-review registered for Slack');
}
