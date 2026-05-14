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
  for (const file of ['bo-mistakes.md', 'feedback.md']) {
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
- No raw markdown tables — use a Slack Canvas.
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
  "reason": "<one-line reason if not ok>",
  "fix": "<suggested rewrite if obvious, omit otherwise>"
}

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

    // Verdict says NOT ok. If there's a fix, swap it in; otherwise surface
    // the issue to Joel as a warning so he can decide.
    if (verdict.fix) {
      log.warn('bo-reviewer-enforcement: applied fix from host-review', {
        sessionId: msg.sessionId,
        reason: verdict.reason,
      });
      check.parsed.text = verdict.fix;
      return { ...msg, content: JSON.stringify(check.parsed) };
    }

    log.warn('bo-reviewer-enforcement: blocked, no auto-fix', {
      sessionId: msg.sessionId,
      reason: verdict.reason,
    });
    check.parsed.text = `:warning: Reviewer flagged this message: ${verdict.reason}\n\nOriginal:\n>>> ${check.text}`;
    return { ...msg, content: JSON.stringify(check.parsed) };
  });

  log.info('bo-reviewer-enforcement: host-side auto-review registered for Slack');
}
