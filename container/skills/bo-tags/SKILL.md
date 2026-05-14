---
name: bo-tags
description: Tag-based control protocol Bo emits in output. The host parses these tags via the `bo-scheduler-tags` plugin and acts on them. Tags are stripped from user-visible content.
---

# Bo Tag Protocol

Bo emits structured tags in output that the host parses and acts on. All tags
are **stripped from the user-visible message** before delivery — they exist
purely to control host behavior.

## Scheduler signal tags (require `bo-scheduler-tags` plugin)

### `<retry reason="..." />`

When a scheduled task partially fails and should be retried (login failed,
service unavailable, browser step timed out, OAuth refresh, etc.), emit:

```
<retry reason="Figma SSO redirect didn't complete" />
```

The scheduler will:
1. First failure → re-queue with 15 min delay.
2. Second failure → re-queue with 30 min delay.
3. Third failure → spawn a healer agent first (see `<healed>`).

Use only for **transient** failures where a retry is likely to succeed.
Don't emit `<retry>` for permanent errors or for tasks that completed
successfully.

### `<healed action="..." />`

When invoked as a healer agent (prompt starts with "You are a self-healing
agent"), if you fixed the underlying issue, end with:

```
<healed action="Refreshed OAuth token via OneCLI" />
```

The scheduler re-fires the original failed task once after seeing this.
Don't re-run the original task yourself.

### `<no-fix reason="..." />`

When invoked as a healer agent, if you couldn't fix the issue:

```
<no-fix reason="Justworks credentials are rotated; 1Password item needs updating" />
```

The scheduler pauses the task and DMs the owner with the diagnosis.

## Self-learning tags (require `bo-self-learning` skill + `bo-features` write target)

### `<memory-write target="..." mode="append|replace-section" section="...">...</memory-write>`

Emit when you've learned something worth remembering — Joel corrected
behavior, expressed a preference, named a constraint, etc.

Targets that exist and are writable from a Slack-wired container:
- `wiki/personal/bo-mistakes.md` — generalized rules from corrections, fed
  into the adversarial reviewer
- `wiki/personal/feedback.md` — softer behavioral notes Bo should follow
- `wiki/personal/joel.md` — facts about Joel's role, preferences, context
- `wiki/projects/<name>.md` — project facts
- `wiki/people/<name>.md` — people facts

Examples:

```
<memory-write target="wiki/personal/bo-mistakes.md" mode="append">
## fact-attribution
Rule: Don't claim a specific person is leading a project without a direct citation.
Why: Inferred Sarah was leading Q3 launch from adjacent context. Joel: "you're making things up."
Example: bad: "Sarah is leading Q3 launch." good: "Per the Q2 planning notes, Sarah is on the Q3 group; lead is unconfirmed."
</memory-write>
```

```
<memory-write target="wiki/personal/feedback.md" mode="append">
Joel prefers Block Kit task reviews even for very short lists — never markdown.
Confirmed: 2026-05-13. Don't ask, just use Block Kit.
</memory-write>
```

The host's outbound transformer strips these tags before delivery and writes
the body to the target file. If the target file doesn't exist it's created.

## When NOT to use a tag

If the thing you want to say is for the user, write it in the message. Tags
are control flow for the host — they're not a way to comment in messages.
