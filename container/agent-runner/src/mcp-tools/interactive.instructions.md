## Interactive prompts

The two tools here solve different problems: `ask_user_question` forces a decision and waits for it; `send_card` displays structured content and moves on.

### Slack Block Kit — three paths, pick the right one

You have three ways to get rich rendering into Slack. Use the simplest one that works.

#### 1. Markdown tables (no special tool needed)

Just write a GitHub-flavored markdown table in any `send_message` / `<message>` reply. The channel adapter parses it and posts a Block Kit `rich_text_table` automatically:

```
| #  | Task                              | Priority |
|----|-----------------------------------|----------|
| 1  | Review competitive analysis doc   | High     |
```

Slack permits at most one table block per message; additional tables in the same message fall back to ASCII in a code fence. **Do not refuse a table request with "send_message only supports plain text" — that was a v1 limitation that no longer applies.**

#### 2. `send_card` — cross-platform structured cards

`mcp__nanoclaw__send_card({ card, fallbackText? })` for the standard `CardElement` schema (title / description / children / actions). Renders to Block Kit on Slack, Adaptive Cards on Teams, native cards on GChat. Use for content that should work on any channel.

#### 3. `send_blocks` — raw Slack Block Kit

`mcp__nanoclaw__send_blocks({ blocks, fallbackText, to? })` for native Slack Block Kit. Use when the `CardElement` schema isn't expressive enough — e.g. section blocks with `fields`, header blocks, dividers separating section groups, accessory elements. Pass an array of Block Kit block objects exactly as you'd send to `chat.postMessage`. `fallbackText` is required (used for notifications and on non-Slack destinations).

Example:

```json
{
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "Today's Tasks" } },
    { "type": "section",
      "text": { "type": "mrkdwn", "text": "*Design sequence preview*" },
      "fields": [
        { "type": "mrkdwn", "text": "*For*\nJames" },
        { "type": "mrkdwn", "text": "*Due*\nFri May 15" }
      ]
    },
    { "type": "divider" }
  ],
  "fallbackText": "Today's tasks: Design sequence preview (for James, due May 15)"
}
```

Do **not** dump raw Block Kit JSON into the `text` field of `send_message` — that posts the literal JSON as a string. The correct tool for raw blocks is `send_blocks`.

### Asking a multiple-choice question (`ask_user_question`)

`mcp__nanoclaw__ask_user_question({ title, question, options, timeout? })` presents the user with a set of choices and **blocks your turn** until they tap one or the timeout expires (default: 300 seconds). Returns their chosen value.

`options` can be plain strings or `{ label, selectedLabel?, value? }` objects:
- `label` — the button text shown before selection
- `selectedLabel` — the text shown on the button *after* selection (useful for confirmations, e.g. `"✓ Confirmed"`)
- `value` — the string returned to you when that option is chosen (defaults to `label`)

Use this when you genuinely cannot proceed without a decision. For free-text input, send a normal message and wait for their reply — don't reach for this tool.

### Structured cards (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` renders a structured card and **returns immediately** — it does not pause your turn or collect a response.

`card` supports: `title`, `description`, `children` (nested text or content blocks), and `actions` (buttons). `fallbackText` is sent as a plain message on platforms without card support.

Use this for presenting information in a cleaner format than prose: summaries, options the user can read (but you're not waiting on), or results with contextual buttons. If you need the user to actually *choose* something and return a value, use `ask_user_question` instead.