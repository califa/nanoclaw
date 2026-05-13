---
name: wiki
description: Maintain Joel's personal LLM Wiki at /workspace/extra/wiki. Covers ingest (processing new sources into wiki pages), query (searching the wiki to answer questions), and lint (health checks). Triggers on wiki-related messages, scheduled ingest tasks, and lint passes.
---

# LLM Wiki Maintenance

You maintain a persistent, compounding knowledge base about Joel's life and work at `/workspace/extra/wiki/`. This follows the Karpathy LLM Wiki pattern: knowledge compiles once and stays current rather than re-deriving on every query.

## Paths

| Path | What | Access |
|------|------|--------|
| `/workspace/extra/wiki/` | The wiki — your maintained output | read-write |
| `/workspace/extra/brain/` | Obsidian vault — source material | read-only |
| `/workspace/extra/wiki/schema.md` | Full conventions and structure | read first |
| `/workspace/extra/wiki/index.md` | Master page index | always consult |
| `/workspace/extra/wiki/log.md` | Append-only activity log | always update |
| `/workspace/extra/wiki/.sync-now.sh` | Obsidian Sync trigger | run after wiki writes |

## Syncing

The wiki lives inside an Obsidian vault that syncs across devices via Obsidian Sync. **After any wiki write operation** (ingest, lint fixes, new pages), trigger a sync:

```bash
bash /workspace/extra/wiki/.sync-now.sh
```

A background launchd agent also syncs every 5 minutes as a safety net, but always trigger manually after writes so changes propagate immediately.

## Quick Reference

**Always start by reading `schema.md`** if you haven't in this session — it has the full conventions.

### Ingest (processing new sources)

When a scheduled task triggers you with new sources, or when Joel drops something for the wiki:

1. Read `index.md` to know what already exists
2. Process each source **one at a time** (never batch):
   - Read the full source
   - Identify: new people, projects, decisions, concepts, themes
   - Create or update wiki pages for each (people/, projects/, decisions/, concepts/, etc.)
   - Add cross-references between related pages
   - Flag contradictions with existing wiki content
3. Update `index.md` with any new pages
4. Append to `log.md`: `## [YYYY-MM-DD] ingest | {Source Description}`

**Source locations in the Brain vault (`/workspace/extra/brain/`):**
- `Meetings/*.md` — AI-summarized meeting notes from Granola (richest source — full transcripts)
- `Daily/*.md` — Daily notes with meeting links
- `People/*.md` — Contact notes from Google Contacts
- Root-level `*.md` — Brain dumps, strategy notes, design thoughts
- `Reference/*.md` — Saved articles and vision docs

**External sources (when triggered by scheduled tasks):**
- Email digests written to `/workspace/extra/wiki/synthesis/`
- Slack digests written to `/workspace/extra/wiki/synthesis/`
- Linear snapshots written to `/workspace/extra/wiki/synthesis/`

### Query

When Joel asks a question that the wiki can help answer:

1. Read `index.md` to find relevant pages
2. Read those pages and synthesize
3. If the answer reveals a gap, note it in the page's Open Questions section
4. If the answer merits its own page, create one

### Lint

When a scheduled lint task fires, or Joel asks for a wiki health check:

1. Read `index.md` to survey all pages
2. Check each category for:
   - **Contradictions** between pages
   - **Orphans** — pages with no inbound cross-references
   - **Stale content** — pages not updated in 30+ days while sources have changed
   - **Missing pages** — people/concepts mentioned in 3+ pages but lacking their own page
   - **Gaps** — important topics with thin or no coverage
3. Report findings concisely
4. Offer to fix — prioritize by impact
5. Log the lint pass: `## [YYYY-MM-DD] lint | {Summary of findings}`

## What Makes a Good Wiki Page

- **People pages** are the highest value — Joel works with many people and needs to recall context: who they are, what they care about, recent interactions, communication style, what they're working on
- **Project pages** should track status, key decisions, and blockers — not just describe the project
- **Decision pages** capture the "why" — the options considered, constraints, and rationale. These are the hardest to reconstruct later
- **Concept pages** capture Joel's mental models and domain expertise — things like "legible workflows", "agentic UX", "list building"
- **Synthesis pages** connect dots across sources — "this week's themes", "hiring pipeline status", "project health summary"

## Ambient Improvement

Beyond explicit ingest/query/lint operations:

- When you notice a topic coming up repeatedly in conversations, check if it has a wiki page
- After answering a question, consider: would a wiki page make this answer available next time?
- When new meeting notes reference tracked people or projects, flag that their wiki pages may need updating
- Keep the index tight — if categories grow past 20 entries, add subcategories
- Periodically (during lint) review which pages are most cross-referenced — these are hubs and should be the most maintained
