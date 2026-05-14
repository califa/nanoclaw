---
name: bo-slack-formatting
description: Strict Slack formatting rules + canonical Block Kit task review template. Loaded into containers wired to Slack channels.
---

# Bo Slack Formatting

This applies to **all** text sent to Slack — `send_message`, `slack_send_message`,
ask_question cards, anything that lands in Slack. The pre-send adversarial
reviewer (`bo-adversarial-reviewer` skill) checks these rules; this skill is
the canonical reference both the reviewer and Bo read from.

## Pre-send checklist — scan every Slack message for these exact strings before sending

| Forbidden | Replace with |
|---|---|
| `**bold**` | `*bold*` (single asterisks ONLY) |
| `##` or `#` headers | `*Bold text*` |
| `[text](url)` | `<url\|text>` |
| `- ` bullet | `•` |

Markdown tables (`\| col \| col \|`) render fine in Slack — feel free to use them.

If any of these patterns appear in the proposed message, fix before sending.
No exceptions.

## Correct Slack mrkdwn reference

| Want | Syntax |
|---|---|
| Bold | `*bold*` (single asterisks) |
| Italic | `_italic_` (underscores) |
| Link | `<https://url\|link text>` |
| Bullet | `•` (literal bullet) |
| Emoji | `:white_check_mark:` `:rocket:` `:warning:` |
| Quote | `> quoted text` |
| Code inline | `` `code` `` |
| Code block | ``` ```code block``` ``` |

## Task Review — Canonical Block Kit Format

Send task reviews as a **Block Kit** message via `slack_send_message` with `blocks`.
No exceptions — task reviews never go out as raw markdown. Send the Canvas link
as a follow-up message after.

The exact text format (confirmed working — May 4 canonical):

```
:clipboard: Task Review — [DATE]
*Current Open Tasks*
• [loose item] — [source/context]
:rotating_light: *High Priority*
*1 — [Task name]*
_[Source meeting/DM]_ · For: [Person / Team]
*Why:* [one-line reason it matters now]
*Action:* :[emoji]: [what to do]
*2 — [Task name]*
...
:large_blue_circle: *Medium Priority*
*N — [Task name]*
_[Source]_ · For: [Person]
*Why:* [reason]
*Action:* :[emoji]: [action]
:white_circle: *Low Priority*
*N — [Task name]*
...
*Sources:* [meeting files] · [Slack msgs] · [Obsidian notes]

Want me to act on any of these? Say *"do all high priority"*, *"just 1 and 3"*, or *"create tasks only"*.
```

Block Kit structure: `header` block for title, `section` blocks (`type: mrkdwn`)
for each priority group + items, `divider` blocks between sections. Then send
a second message with the Canvas URL.

## When Joel says "use the canonical format" or "use Block Kit"

He means the template above. Use it exactly — don't paraphrase, don't drop
emoji headers, don't switch to a markdown list.
