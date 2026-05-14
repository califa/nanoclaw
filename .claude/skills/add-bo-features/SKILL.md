---
name: add-bo-features
description: Install Joel's personal NanoClaw customizations (adversarial reviewer, self-learning, voice transcription, scheduler tags, slack formatting, LLM wiki integration) from the bo-features sibling branch. Idempotent — safe to re-run after /update-nanoclaw.
---

# Add Bo Features

Personal customizations for Joel's NanoClaw install. Mirrors the
`/add-slack` / `/add-discord` install pattern: fetch the `bo-features`
sibling branch, copy files into well-known locations, install pinned
deps, run migrations, build, restart.

**Requires** the trunk extension-points patch (commit on `main` that
adds `src/extension-points.ts`, `src/plugin-loader.ts`, transformer
hooks in `router.ts` and `delivery.ts`). Without that patch the plugins
in `src/plugins/` won't be loaded.

## Phase 1: Pre-flight

```bash
# Verify the trunk extension-points patch is present
grep -q "loadPlugins" src/index.ts && echo "OK" || echo "MISSING: run upstream merge first"
```

If missing, do not proceed — the install will copy files that the host
can't load.

## Phase 2: Apply

```bash
bash .claude/skills/add-bo-features/install.sh
```

The script is idempotent: re-run after any `/update-nanoclaw` to
refresh plugin code or pick up new bo-features commits.

## Phase 3: Verify

```bash
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw-v2-40b8cd25"
sleep 5
grep -E "Plugin loaded" logs/nanoclaw.log | tail
```

You should see one log line per plugin in `src/plugins/`. Container
skills are picked up by new sessions, not the host — to see them
active, send Bo a message and check the container's tool list.

## What's in bo-features

### Plugins (host-side, via extension points)

| Plugin | Purpose |
|---|---|
| `bo-voice` | Inbound audio → Whisper transcription, prepended as `[Voice: ...]` |
| `bo-scheduler-tags` | Handlers for `<retry>` / `<healed>` / `<no-fix>` tags emitted by Bo in scheduled tasks |
| `bo-token-usage` | Logs token usage per session into `data/v2.db.token_usage` table, surfaces via dashboard |
| `bo-attachments` | Image/PDF passthrough — saves attachments to session dir, agent-runner forwards as native content blocks |
| `bo-telegram-reply-context` | Pulls `reply_to_message` from Telegram updates, prepends `<reply_context>` block to message content |

### Container skills (loaded into agent containers)

| Skill | Purpose |
|---|---|
| `bo-slack-formatting` | Pre-send checklist, forbidden patterns, Block Kit task review canonical format |
| `bo-tags` | Documents the `<retry>` / `<healed>` / `<no-fix>` / `<memory-write>` tag protocols Bo emits |
| `bo-adversarial-reviewer` | Bo invokes a TeamCreate critic before every Slack send. Loads `wiki/personal/bo-mistakes.md` as dynamic rules |
| `bo-self-learning` | After every turn where Joel corrected Bo, distill the correction into a generalized rule and append to `bo-mistakes.md` |
| `bo-llm-wiki` | Karpathy LLM wiki conventions — tailored to Joel's existing `Brain/xtra/wiki/` structure |

### Migrations

| File | What it adds |
|---|---|
| `migrations/bo-001-scheduled-task-retry.ts` | `scheduled_tasks.retry_count`, `last_failure_reason`, `paused_reason` |
| `migrations/bo-002-token-usage.ts` | `token_usage(id, session_id, agent_group_id, model, input_tokens, output_tokens, cache_*, ts)` |
