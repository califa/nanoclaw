---
name: bo-self-learning
description: Capture Joel's corrections and preferences, distill them into generalized rules, write to the wiki so future Bo turns + the adversarial reviewer benefit.
---

# Bo Self-Learning

When Joel corrects Bo or expresses a preference, **don't just acknowledge it
and move on** — capture it, generalize it, and store it where future Bo runs
will read it. This skill defines the capture/distill/store loop.

## What to capture

### Strong signals (always capture)

| Signal | Example |
|---|---|
| Explicit correction | "no", "stop doing X", "don't", "that's wrong because Y" |
| Explicit preference | "I prefer", "always", "never", "I asked you to" |
| Format complaint | "use the canonical format", "this is markdown not Block Kit" |
| Factual correction | "you're making this up", "where did you get that?", "that's not what happened" |
| Behavioral rule | "from now on", "going forward", "in the future" |
| Validated approach | Joel accepts an unusual approach without pushback OR explicitly confirms ("yes, that's the right call") |

### Weak signals (capture if context warrants)

- Subtle dissatisfaction ("hmm, ok" after a long pause; "let me try myself")
- Repeated questions about the same thing (suggests Bo's previous answers
  weren't sticking)
- Joel rewording a request after Bo's first answer (often means the answer
  missed)

## What to do at end of every turn

1. **Scan Joel's most recent message** for any of the signals above.
2. If none → no action.
3. If one or more → for each, ask yourself:
   - **What was the specific case?** (quote it)
   - **What's the generalizable rule?** (one sentence, applies beyond just
     this case)
   - **Where does it belong?** (see Targets below)
4. **Emit a `<memory-write>` tag** with the rule (see `bo-tags` for syntax).
   The host appends it to the target file.

## Distillation discipline

Bad distillation creates noise that bloats the reviewer's prompt and creates
false positives. Good distillation is rare and specific.

### Good distilled rules
- "Don't claim a specific person is leading a project without a citable source."
- "Joel prefers Block Kit task reviews even for very short lists."
- "When summarizing meetings, prefer transcript quotes over auto-generated
  summary headers — the headers misattribute frequently."

### Bad distilled rules (don't write these)
- "Don't make mistakes." (too general)
- "Don't say Sarah is leading Q3." (too specific — won't generalize)
- "Be careful with people facts." (vague)

### Rule of thumb
A good rule (a) has a check the adversarial reviewer can apply to a future
message, and (b) prevents at least one specific class of mistake.

## Where to write

| Target | Use for |
|---|---|
| `wiki/personal/bo-mistakes.md` | **Generalized rules from corrections.** The adversarial reviewer reads this. Most distillations go here. |
| `wiki/personal/feedback.md` | Softer behavioral notes that don't fit a "rule" shape but should influence behavior — tone preferences, things Joel cares about. |
| `wiki/personal/joel.md` | Facts about Joel that affect Bo's decisions (role, schedule, current focus, working style). |
| `wiki/projects/<name>.md` | Facts about a specific project (status, stakeholders, decisions). Use existing page if one exists. |
| `wiki/people/<name>.md` | Facts about a specific person (role, relationship to Joel, current state). |

Pick the most-specific target. A correction about a specific project goes
under the project page, not in bo-mistakes. A formatting rule goes in
bo-mistakes. A statement about Joel's daily routine goes in joel.md.

## How to actually write (the only mechanism that works)

**Emit a `<memory-write>` tag in your reply.** The host plugin
`bo-memory-write` parses the tag, writes the body to the resolved file
under `/Users/joel/Brain/xtra/wiki/`, and **strips the tag from the
user-visible reply** so it doesn't appear in Slack.

If you just say "Done, noted" in your reply without emitting the tag,
**nothing is persisted**. The user will think you saved a rule but the
next turn (and the next reviewer call, and every future container) won't
have it. Don't do that.

### Exact syntax (copy this exactly)

```
<memory-write target="wiki/personal/bo-mistakes.md" mode="append">
## <short-rule-slug>
Rule: <one-sentence rule the reviewer can check against>
Why: <YYYY-MM-DD> — <what triggered this; quote Joel if relevant>
Example: bad: "<short bad quote>" good: "<short good quote>"
</memory-write>
```

`target` paths are relative to the wiki root. The plugin rejects anything
that resolves outside `/Users/joel/Brain/xtra/wiki/`.

`mode="append"` adds the body to the end of the file (creates the file
if missing). `mode="replace-section" section="<name>"` replaces the
existing `## <name>` block with the new body — use this when correcting
or updating an existing rule.

### Worked example

User: "stop using ** in slack, single asterisks only."

Your reply text → "Got it, switching to single asterisks going forward."

Your reply ALSO includes (these are stripped from what the user sees):

```
<memory-write target="wiki/personal/bo-mistakes.md" mode="append">
## slack-single-asterisks
Rule: Slack bold must use single asterisks, never double.
Why: 2026-05-14 — used `**bold**` in a reply; Joel: "stop using ** in slack, single asterisks only."
Example: bad: `**hello**` good: `*hello*`
</memory-write>
```

Result: the bo-mistakes.md file gets the new rule appended; the adversarial
reviewer reads it on every subsequent qualifying Slack send. The rule
sticks.

## Format for `bo-mistakes.md` entries

The reviewer reads this file. Keep entries scannable. The exact shape:

```markdown
## <short rule slug>
Rule: <one-sentence rule the reviewer can check against>
Why: <date> — <one-sentence what happened that triggered this>
Example: bad: "<short bad quote>" good: "<short good quote>"
```

## Format for `feedback.md` entries

Free-form, dated, one paragraph per entry.

```markdown
## 2026-05-13
Joel prefers I always use Block Kit for task reviews, even very short ones.
He gets annoyed if I ask whether to use Block Kit — just use it. Confirmed
when I asked and he said "stop asking, use it."
```

## Don't double-write

Before writing, scan the target file for an existing similar rule. If one
exists, **update it** with a more recent date or sharper wording instead of
creating a duplicate. The reviewer reads everything in the file — duplicates
cost tokens without adding value.

## Don't silently mention captures

Don't tell Joel "I'm noting that for future" or "I'll remember that" —
just write to the file and move on. The capture is silent. If he asks
"do you remember when I said X" you can confirm; otherwise stay quiet.

## Frequency check

If you're writing to `bo-mistakes.md` more than a few times a week, you're
probably distilling too aggressively. Pull back to strong signals only.

If you go a month without writing anything, you're probably under-capturing.
Review recent corrections and ask whether any deserved a rule.
