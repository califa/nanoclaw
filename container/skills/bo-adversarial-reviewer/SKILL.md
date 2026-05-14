---
name: bo-adversarial-reviewer
description: Pre-send adversarial reviewer for Slack outbound. Loads static rules + dynamic mistake memory and rejects/fixes/escalates messages that violate them.
---

# Bo Adversarial Pre-Send Reviewer

Before every Slack outbound, Bo runs a **critic sub-agent** that reviews the
proposed message against:
1. Static formatting rules (from `bo-slack-formatting`).
2. **Dynamic mistake memory** — generalized rules distilled from Joel's past
   corrections (`bo-self-learning` writes these).

The critic returns a verdict; Bo acts on it before sending.

## When the reviewer fires

**Always fire** before sending to Slack if:
- Message is ≥50 characters, OR
- Message contains any claim about a person (name + action/state), OR
- Message is a task review / digest / briefing / summary

**Skip the reviewer** when:
- Sending a one-sentence proactive acknowledgement via `send_message`
  ("Pulling that up now...")
- Message is a verbatim quote of an earlier Bo message being re-sent
- Message body is under 50 characters AND contains no person-claim

The reviewer is **mandatory** for all task-review messages — no exceptions.

## The flow

### Step 1 — Load dynamic rules

Before invoking the critic, read these files. They contain generalized rules
distilled from past corrections.

```bash
cat /workspace/extra/wiki/personal/bo-mistakes.md 2>/dev/null
cat /workspace/extra/wiki/personal/feedback.md 2>/dev/null
```

Both files are append-only logs; the critic should consider every entry.

### Step 2 — Call TeamCreate with the reviewer prompt

```
TeamCreate(
  task: """
  You are Bo's strict pre-send reviewer for Slack messages. Your job is to
  catch mistakes before they go out.

  Static rules (always apply):
  - No `**double asterisks**` — use `*single*`.
  - No `##` or `#` headers — use `*Bold text*`.
  - No `[text](url)` — use `<url|text>`.
  - No `- ` bullets — use `•`.
  - No table syntax — use a Canvas instead.
  - Task reviews must be Block Kit, not raw text.

  Dynamic rules (loaded from Bo's mistake memory — apply every applicable one):
  <pasted content of bo-mistakes.md>
  <pasted content of feedback.md>

  Factual discipline rules (always apply):
  - Every claim about a specific person must trace to a single citable source.
    If inferring, the message must surface the inference, not state it as fact.
  - Negative signals (reject, no-hire, leaving) override positive context.
  - Don't let narrative coherence pull toward false claims.

  Message to review:
  ---
  <proposed message text>
  ---

  Return JSON only:
    {
      "ok": true|false,
      "violated_rules": ["rule-id-1", "rule-id-2"],  // empty if ok
      "reason": "...",                                 // short, if not ok
      "fix": "...",                                    // suggested rewrite if obvious; null if not
      "should_escalate": true|false                    // true if needs Joel's judgment
    }

  Be strict. Default to false if uncertain.
  """,
  agents: ["reviewer"]
)
```

### Step 3 — Act on the verdict

| Verdict | Action |
|---|---|
| `ok=true` | Send the message as-is. |
| `ok=false`, `fix` provided, `should_escalate=false` | Send the fix instead. Note "(reviewed; fixed: <rule>)" only in your own scratch — don't tell Joel unless asked. |
| `ok=false`, no fix OR `should_escalate=true` | Send a message to Joel surfacing the issue: "Reviewer flagged: <reason>. Want me to send anyway, or rewrite?" Do NOT send the original. |

### Step 4 — Capture the result

If the verdict was `ok=false` AND you fixed it AND the rule was based on
dynamic mistake memory: the rule is working. No action needed.

If the verdict was `ok=false` AND it caught a brand-new category of mistake
that isn't already in `bo-mistakes.md`: emit a `<memory-write>` tag adding
the new rule to mistake memory (see `bo-tags` skill for syntax). This is how
the reviewer learns over time.

## Why this pattern

The reviewer compounds. Every time Joel corrects a mistake, `bo-self-learning`
distills the correction into a generalized rule and writes it to
`bo-mistakes.md`. The next time Bo is about to send a similar message, the
reviewer reads that rule and blocks the mistake before it goes out. The
mistake catalog grows. The same class of mistake gets harder and harder to
re-make.

## Cost gates

The reviewer is a sub-agent invocation per outbound — it costs tokens. Gates:

- **Sample mode** (first week of any new rule): only run on 50% of outbound,
  log the gap. Confirms the rule's working before always-on.
- **Always-on** (after sampling confirms): every qualifying outbound.
- **Hard skip**: messages under 50 chars and no person-claim never run the
  reviewer.

Adjust gates in this file as you learn what's worth reviewing.
