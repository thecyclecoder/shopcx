---
name: write-brain-page
description: Use when adding a new table, Inngest function, library file, or external integration to ShopCX — every one needs a docs/brain/ page in the SAME PR (CLAUDE.md hard rule: code without a brain page is incomplete). Scaffolds tables/{name}.md · inngest/{name}.md · libraries/{name}.md · integrations/{name}.md in the house format, cross-linked and indexed.
---

# write-brain-page

`docs/brain/` is the system map and the authoritative reference — read before grepping `src/`. So every new table / Inngest function / library file / integration MUST land as a brain page **in the same change** as the code. This skill scaffolds that page in the folder's house format and wires it into the index.

## Which folder

| You added… | Page goes in | Mirrors |
|---|---|---|
| a `public.*` table | `tables/{table_name}.md` | columns, FKs (both directions), common queries, gotchas |
| a `src/lib/inngest/*.ts` fn | `inngest/{name}.md` | trigger event/cron, retries/concurrency, downstream events, tables read/written |
| a `src/lib/*.ts` file | `libraries/{name}.md` | exports + signatures, callers (grep'd), gotchas |
| a new external API | `integrations/{name}.md` | auth model, credential location, key endpoints, rate limits/retries, gotchas |

## Procedure

1. **Pick the folder** from the table above. **Open two existing siblings** in that folder and match their structure exactly — section order, heading depth, the `[[wikilink]]` style. The format is per-folder (see [[README]] § What's here); don't invent one.
2. **Fill from reality, not memory.** Probe the table for its real columns/enums (the `probe-db` skill — the database is the spec), grep the lib file for its real exports + callers, read the Inngest fn for its real trigger + `inngest.send` targets + table writes. Prose drifts; the code/DB is the source.
3. **Cross-link 3–5 related pages** with `[[wikilinks]]`, and make sure **at least one existing page links back to the new one** — an orphan page is invisible. (e.g. a new table gets linked from the lifecycle that writes it.)
4. **Add the index entry.** Append a one-line `- [[folder/name]] — one-line summary.` to the matching section of `docs/brain/README.md`, and **bump that folder's count** in the "What's here" table at the top. Tables also go under the right category sub-list (Core / Tickets / AI / …).
5. **Encrypted + UUID conventions.** Encrypted columns end `_encrypted` (AES-256-GCM via [[libraries/crypto]]). Document internal FKs as **UUIDs**; flag any `shopify_*_id` as a boundary-only field, never an internal join key.

## Guardrails

- **Same PR as the code.** A brain page in a later commit doesn't satisfy the rule — reviewers read the brain to review the code.
- **No invented APIs.** Don't document columns/exports/events that aren't in the code. If unsure, probe/grep first. A wrong brain page is worse than none.
- **Lowercase enums.** Status/enum text columns are lowercase everywhere — record the exact strings (probe a sample), not a guessed casing.
- This is the **scaffold-a-new-page** skill. Folding a *shipped spec's* knowledge into existing pages on verify is a different skill — [[fold-to-brain]].

## Related
`docs/brain/README.md` · `docs/brain/tables/` · `docs/brain/inngest/` · `docs/brain/libraries/` · `docs/brain/integrations/` · skills: `probe-db`, `fold-to-brain`, `write-migration` · `CLAUDE.md` (§ Authoritative reference)
