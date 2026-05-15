---
name: bo-slack-formatting
description: Strict Slack formatting rules. Loaded into containers wired to Slack channels. The validated rules in wiki/personal/bo-mistakes.md override any guidance in this file.
---

# Bo Slack Formatting

## Rule precedence (READ FIRST)

When guidance conflicts, follow this order — top wins:

1. **Joel's instruction in the current thread.** Always.
2. **`wiki/personal/bo-mistakes.md`** — validated rules saved from past corrections.
3. **`wiki/personal/bo-reviewer-patterns.md`** — auto-distilled clusters of past blocks.
4. **This skill (`bo-slack-formatting`)** — general formatting reference.
5. **`bo-adversarial-reviewer`** — pre-send static checks.

If you notice this file contradicting bo-mistakes.md, treat bo-mistakes.md as authoritative and update this file (or ask Joel to).

## Output paths to Slack — what each produces

| Path | Produces | Use when |
|---|---|---|
| `<message to="bo-ai">…</message>` body containing **one GFM markdown table** with no other content | `rich_text_table` Block Kit block | Tabular data |
| `<message to="bo-ai">…</message>` body with prose / lists / emoji | mrkdwn text message | Normal replies |
| `mcp__nanoclaw__send_message({ text })` | mrkdwn text message (identical to bare `<message>` text — the bridge auto-converts markdown tables here too) | Mid-turn updates |
| `mcp__nanoclaw__send_card({ card, fallbackText })` | Block Kit via CardElement (title / description / Section / Fields / Divider / Actions / Table) | Cross-platform structured cards |
| `mcp__nanoclaw__send_blocks({ blocks, fallbackText })` | Raw Block Kit, posted verbatim via `chat.postMessage` | Section blocks with `fields`, header blocks, divider sequences, accessory elements |

There is **no path** where `send_message` strips markdown tables. The bridge passes the body to `adapter.postMessage({markdown: …})`, which runs `toBlocksWithTable(parseMarkdown(…))` for every Slack post. Stop inventing distinctions between "send_message strips tables" and "`<message>` tags convert them" — they go through the same code.

## Inviolable Slack rules

These come from prior Joel corrections. The pre-send reviewer enforces them.

| Forbidden | Replace with | Why |
|---|---|---|
| `**bold**` | `*bold*` (single asterisks) | Slack mrkdwn uses single, not double |
| `##` or `#` headers | `*Bold text*` | Slack does not parse markdown headers |
| `[text](url)` | `<url\|text>` | Slack syntax for links |
| `- ` bullets | `•` | Slack does not render `- ` as a bullet |

## Tables — the rules you keep forgetting

1. **One table per message, period.** Slack's `toBlocksWithTable` step uses *one* `rich_text_table` block per `chat.postMessage` call. Additional tables in the same message body fall back to ASCII inside a code fence — which looks broken. If you have three priority tiers, send three separate messages.
2. **Don't put prose around the table.** Put the table on its own. Send a separate message first if you need context. Mixing prose + table in one body sometimes prevents the auto-conversion entirely.
3. **Never use Block Kit `fields` sections to render a task list.** Fields render as a cramped 2-column grid intended for key/value pairs (≤4 items, short strings). Use `rich_text_table` blocks for tabular data instead.
4. **The host enforces (1) automatically.** If you emit multiple tables in one body, the Slack channel adapter splits them into separate messages before posting. You don't have to remember it. You should still avoid it because the split is brittle.

## Verifying that something rendered

You **cannot** know whether a Slack message rendered as a table by reasoning about your input. Don't claim "yes that rendered as a table" from inference.

If Joel asks "did it render?" and you haven't actually checked, the only correct answer is one of:

- *Call `mcp__nanoclaw__inspect_message({ messageId })`* — returns the block types Slack accepted. Quote them in your reply.
- *"I can't verify from here — does it look right on your end?"*

Never guess. Never say "yes" without evidence. This applies to every claim about delivered state, not just Slack rendering.
