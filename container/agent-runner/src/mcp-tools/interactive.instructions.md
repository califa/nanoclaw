## Interactive prompts

The two tools here solve different problems: `ask_user_question` forces a decision and waits for it; `send_card` displays structured content and moves on.

### Slack Block Kit — markdown tables auto-convert

On Slack, you do **not** need a special API for table rendering. Write a normal GitHub-flavored markdown table in the body of any `send_message` / `<message>` reply and the channel adapter parses it into a Block Kit `rich_text_table` automatically:

```
| #  | Task                              | Priority |
|----|-----------------------------------|----------|
| 1  | Review competitive analysis doc   | High     |
| 2  | Mock up draft approval workflow   | High     |
```

This is `chat.postMessage` with `blocks` under the hood — the adapter's `toBlocksWithTable` step. Slack permits at most one table block per message; additional tables in the same message fall back to ASCII inside a code fence, which is also fine. **Do not refuse a table request with "send_message only supports plain text" — that was a v1 limitation that no longer applies.**

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