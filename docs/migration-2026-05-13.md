# NanoClaw v1 → v2 migration — 2026-05-13

Migrated v1 (1.2.45) to v2 on 2026-05-13. Same day, the install dirs were also renamed: the v2 install (which during the migration lived at `/Users/joel/nanoclaw-v2/`) was moved to `/Users/joel/nanoclaw/`, and the v1 install (originally at `/Users/joel/nanoclaw/`) was moved to `/Users/joel/nanoclaw-v1-legacy/`. References below use the **current** paths.

## Deterministic phase (migrate-v2.sh)

All 6 steps succeeded:

| Step | Status | Notes |
|------|--------|-------|
| 1a-env | success | Merged .env keys from v1 |
| 1b-db | success | Seeded `data/v2.db` (3 agent groups, 3 messaging groups, wirings) |
| 1c-groups | success | Copied 5 folders, 5 CLAUDEs, 131 files |
| 1d-sessions | success | Copied 3 sessions with conversation continuity |
| 1e-tasks | success | Ported scheduled tasks |
| 3e-build | success | Built nanoclaw-agent container image |

`channels_installed: []` — channel selection was deferred to `/migrate-from-v1`. `service_switched: false` — service swap happened later.

## Interactive phase (/migrate-from-v1)

### Phase 0a — Channel adapters installed

Ran `setup/install-{slack,telegram,whatsapp}.sh`. Copied Slack/Telegram/WhatsApp adapter modules from the `channels` branch, registered self-imports, installed pinned `@chat-adapter/*@4.26.0` + Baileys `7.0.0-rc.9`.

Also manually copied `/Users/joel/nanoclaw-v1-legacy/store/auth/` → `/Users/joel/nanoclaw/store/auth/` (2168 Baileys keystore files including `creds.json`). The `CHANNEL_AUTH_REGISTRY.whatsapp.candidatePaths` in `setup/migrate-v2/shared.ts` does not include `store/auth/`, so this would have been missed even if WhatsApp had been selected during the script run.

### Phase 0b — Service swap + smoke test

- Unloaded `com.nanoclaw` (v1 PID 17075).
- Loaded `com.nanoclaw-v2-40b8cd25`.
- Two boot blockers surfaced:
  1. **Port 3000 EADDRINUSE** — open-webui Docker container holds it. Added `WEBHOOK_PORT=3030` to both `.env` AND to the plist's `EnvironmentVariables` block. `src/webhook-server.ts:82` reads `process.env.WEBHOOK_PORT` directly (not via `readEnvFile`), so the .env addition alone wouldn't have helped under launchd. **Workaround stays in the plist** — if the plist is regenerated, re-add `WEBHOOK_PORT`. Long-term fix would be teaching webhook-server.ts to read .env via `readEnvFile`.
  2. **SLACK_SIGNING_SECRET missing** — v1 used Slack socket mode (app token). v2's `@chat-adapter/slack` doesn't support socket mode; it requires `signingSecret` for webhook validation. User pasted the secret from api.slack.com/apps → Basic Information.
- WhatsApp adapter reconnected cleanly and synced 50 group metadatas using the copied Baileys keystore — no re-pairing.
- Slack adapter **loads** but inbound messages won't arrive until the Slack app's Event Subscriptions Request URL points to `https://<public-https>/webhook/slack`. v1 socket mode worked without a public URL; v2 webhook mode needs one. **Outstanding** — user can configure later.

### Phase 1 — Owner role + access policy

- Granted `owner` role to both Joel identities: `telegram:8561656008`, `whatsapp:19179719700@s.whatsapp.net`.
- Tightened `unknown_sender_policy` from `public` → `strict` on all 3 messaging groups (Telegram DM, WhatsApp Self Chat, Slack `bo-ai`). Owner privilege bypasses this.

### Phase 2 — CLAUDE.local.md cleanup

| Group | Lines (before → after) | What was kept |
|-------|------------------------|---------------|
| `main` | 489 → 172 | Identity, Retry/Healer signals, Helium Browser, Email Notifications, LLM Wiki |
| `slack_main` | 641 → 334 | Identity, preference-learning rules, Helium, Self-Healing Logins, Slack Block Kit format, Parallel routing, LLM Wiki, Nanoclaw Host Operations (v2 paths) |
| `telegram_main` | 309 → 3 | Identity only |
| `whatsapp_main` | 309 → 3 | Identity only |

Originals saved as `groups/<name>/CLAUDE.local.md.v1-backup`.

Path fixes applied throughout kept content:
- `/workspace/group/` → `/workspace/agent/`
- `/workspace/ipc/...` → removed (no IPC in v2)
- v1 paths in slack_main Host Operations updated to v2 (later flattened: now plain `/Users/joel/nanoclaw/`)
- `com.nanoclaw` (service name) → `com.nanoclaw-v2-40b8cd25`

### Phase 3 — Container mounts

All `additionalMounts` host paths verified:

- `/Users/joel/Brain` (read-only) ✓
- `/Users/joel/Brain/wiki` (read-write) ✓
- `/Users/joel/Brain/Generated` (slack_main only, read-write) ✓
- `/Users/joel/Brain/Daily` (read-write) ✓

No `.v1-container-config.json` fallbacks. No `container.json` for the `main` group folder — but no agent group is wired to it either (it's an orphan from v1 with no v2 agent_group row).

### Phase 4 — Fork customizations

v1 fork was **225 commits** ahead of upstream. Stashed reference at `docs/v1-fork-reference/` (commits.txt, diffstat.txt, README.md). No source-level porting — v2's architecture diverges enough that patches don't apply.

## Helium proxy sidecar

The v1 fork integrated a custom HTTP proxy at `host.docker.internal:9224` into its main Node process. It provided per-tab gating (`/helium/...`), the 1Password credential pipeline (`/credentials/...`), and the Slack `/send-file` endpoint. v2's host doesn't include any of this.

Rather than port the ~930 lines into v2 now, we run the v1 compiled module as a sidecar:

- Wrapper: `scripts/helium-proxy-sidecar.mjs` — imports `/Users/joel/nanoclaw-v1-legacy/dist/helium-api.js` and calls `startHeliumApi()`.
- Service: `~/Library/LaunchAgents/com.nanoclaw-helium-proxy.plist` — KeepAlive, WorkingDirectory=`/Users/joel/nanoclaw-v1-legacy` (so the v1 module finds its `.env`).
- Logs: `logs/helium-proxy.log` + `logs/helium-proxy.error.log`.

To control:

```bash
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw-helium-proxy"   # restart
launchctl bootout   "gui/$(id -u)/com.nanoclaw-helium-proxy"      # stop
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.nanoclaw-helium-proxy.plist  # start
```

The v1 working tree (`/Users/joel/nanoclaw-v1-legacy/`) must remain intact — the sidecar reads `dist/helium-api.js`, `dist/logger.js`, `dist/env.js` from there. Don't delete v1-legacy or rebuild it in a way that purges `dist/`. Long-term: port the helium-api into the v2 host (or a separate sidecar package), then v1-legacy can be retired entirely.

## Slack inbound — Tailscale Funnel

v1 used Slack socket mode (app token). v2's `@chat-adapter/slack` is webhook-only — it needs Slack's servers to POST events to a public HTTPS endpoint. Stable, free path: **Tailscale Funnel**.

- Tailscale Serve enabled on tailnet via `https://login.tailscale.com/f/serve?node=n4HEHQ6cf911CNTRL` (one-time).
- Active config:

  ```
  tailscale serve  --bg http://127.0.0.1:3030
  tailscale funnel --bg --https=443 http://127.0.0.1:3030
  ```

  (Configs persist through `tailscaled` — they survive reboots; no launchd job needed.)

- **Slack Request URL:** `https://mini.tail4b9e08.ts.net/webhook/slack`
- End-to-end verified — POSTing to that URL reaches v2's webhook server and gets validated by `SLACK_SIGNING_SECRET`.

To configure in Slack: api.slack.com/apps → app → Event Subscriptions → paste Request URL → Verify. Then under *Subscribe to bot events* add `message.channels`, `message.groups`, `message.im`, `app_mention`. Save.

## Outstanding / TODO

- **WEBHOOK_PORT in plist**: if `/setup` regenerates the plist, re-add the `WEBHOOK_PORT=3030` `EnvironmentVariables` entry.
- **Orphan `groups/main/` folder**: leftover from v1; left in place per user choice.
- **Slack app Event Subscriptions**: paste the Request URL above and add the four bot events. Slack will send a `url_verification` challenge — v2 responds correctly.
