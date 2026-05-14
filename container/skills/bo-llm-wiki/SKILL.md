---
name: bo-llm-wiki
description: Karpathy LLM Wiki conventions tailored to Joel's existing /workspace/extra/wiki/ tree. Reads + writes structured knowledge so it persists and compounds.
---

# Bo LLM Wiki

Joel maintains a persistent, compounding knowledge base about his life and
work. Follows the Karpathy LLM Wiki pattern — knowledge is **compiled once**
into structured wiki pages rather than re-derived on every query.

## Architecture

Three layers:

1. **Raw sources** (read-only at `/workspace/extra/brain/`) — Joel's Obsidian
   vault: meeting notes, daily notes, brain dumps, contacts. Plus Gmail,
   Calendar, Linear, Slack via MCP tools.
2. **The wiki** (read-write at `/workspace/extra/wiki/`) — Bo's maintained
   output. Structured markdown organized by category.
3. **The schema** (`wiki/schema.md`) — Full conventions. Read this file
   before any wiki operation.

## Index of key files

| File | Purpose |
|---|---|
| `wiki/schema.md` | Conventions, page format, operations — read first |
| `wiki/index.md` | Master index of every wiki page — always consult |
| `wiki/log.md` | Append-only activity log — append to after any change |
| `wiki/corrections.md` | Known errors in raw source files — check before any briefing |

## Categories

| Directory | Contains |
|---|---|
| `wiki/people/` | Per-individual entity pages |
| `wiki/projects/` | Initiatives, workstreams, products |
| `wiki/company/` | Unify org context, strategy, processes |
| `wiki/decisions/` | Key decisions with rationale |
| `wiki/concepts/` | Mental models, recurring themes |
| `wiki/synthesis/` | Cross-source analysis, weekly digests |
| `wiki/personal/` | Joel's goals, preferences, operating style. Also where `bo-mistakes.md` + `feedback.md` (self-learning targets) live. |

## Operations

### Ingest

Process new sources **one at a time**:

1. Read the full source.
2. Identify all entities (people, projects, concepts) referenced.
3. For each entity: create or update its wiki page with the new info.
4. Add cross-references between pages.
5. Update `wiki/index.md` if any new page was created.
6. Append to `wiki/log.md`: `<date> — ingested <source> — touched <pages>`.

**Never batch-process multiple sources.** Read one, fully integrate it,
then move to the next. Batching produces shallow, generic pages instead of
deep integration.

### Query

When Joel asks about a person, project, or past decision:

1. Check `wiki/index.md` first.
2. Read the relevant page(s).
3. If the answer's not in the wiki, supplement from raw sources (then
   consider whether the answer should now be a new wiki page).
4. **Trust the wiki over raw sources** when they conflict. The wiki is the
   verified, corrected source; raw sources are unverified.

### Lint

Weekly health check (run when scheduled):
- Contradictions between pages
- Orphaned pages (no inbound references)
- Stale content (entities referenced as "current" in pages older than X days)
- Missing pages (entities mentioned in `wiki/log.md` ingestions but not yet
  having pages)
- Gaps (categories that haven't been updated recently)

Report findings; don't auto-fix without confirmation.

## Critical rules

- **Check `wiki/corrections.md` before any briefing or factual summary.**
  This file lists known errors in raw source files. Read it first.
- **Meeting note headers lie. Transcripts are more reliable.** Granola
  auto-generates summary headers that misattribute who said what. Never
  trust a `## Note` section without cross-checking the wiki + transcript.
- **Update the wiki when you learn new things.** When Joel tells you
  something new (decision, hire, rejection, status change, preference):
  immediately update the relevant page AND add a `wiki/corrections.md`
  entry if the new info contradicts a raw source. Don't wait for a
  scheduled ingest.

## Proactive updates during conversation

When a person, project, or decision comes up that doesn't have a wiki page
yet, **create one immediately** with whatever you know — role, company,
relationship to Joel, context of the mention. Fill in more later. Update
`index.md` and append to `log.md` after.

Don't tell Joel you're doing this. It's silent background maintenance.

## Connection to bo-self-learning

The `bo-self-learning` skill writes to `wiki/personal/bo-mistakes.md` and
`wiki/personal/feedback.md`. Those files **are part of this wiki** — same
folder structure, same conventions. They're the "preferences and rules"
sub-domain of the wiki. The adversarial reviewer reads them.
