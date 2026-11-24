# `src/lib/support-content.ts` — support-content SDK

The write chokepoint for [[../tables/knowledge_base]] (help-center articles) and [[../tables/macros]] (canned support replies). Both feed customer-facing AI through embeddings: articles are chunked into `kb_chunks` and retrieved by [[rag]], and macros carry their own `embedding` for macro suggestions. A content edit that skips the re-embed leaves the AI quoting the old text, even though the dashboard shows the new one.

That is how "Mixed Berry Tabs have 40mg of caffeine" survived in 8 rows (1 article, 7 macros) until Nov 2026, while the label for every flavor says 100mg. The SDK couples every content write with its re-embed.

## Exports

| Export | Notes |
|---|---|
| `getKbArticle(admin, workspaceId, id)` | → `KbArticleRow \| null`. Workspace-scoped. |
| `getMacro(admin, workspaceId, id)` | → `MacroRow \| null`. Workspace-scoped. |
| `updateKbArticleContent({workspaceId, id, content, contentHtml?, reembed?}, admin?)` | Writes `content` (+ `content_html` when given), then rebuilds the RAG chunks. `reembed: "event"` (default) fires `kb/document.updated` for [[../inngest/kb-embed]]. `"inline"` rebuilds in-process, for scripts with no Inngest key. Throws if the row is not in the workspace. |
| `updateMacroBody({workspaceId, id, bodyText, bodyHtml?}, admin?)` | Writes `body_text` (+ `body_html`), then recomputes `embedding` / `embedding_text` from `name. body_text`, the same shape the macro PATCH route uses. |
| `reembedKbArticle(admin, workspaceId, id)` | Inline chunk → delete old `kb_chunks` → embed + insert. Same steps as the kb-embed Inngest function. Returns the chunk count. |
| `reembedMacro(admin, workspaceId, id)` | Recompute one macro's embedding. Returns false when the embedding API returns nothing. |
| `KbArticleRow` / `MacroRow` / `KbReembedMode` | types |

## Enforcement: a ratchet

[scripts/_check-support-content-sdk-compliance.ts](../../../scripts/_check-support-content-sdk-compliance.ts) (`npm run check:support-content-sdk-compliance`, chained into `predeploy:static`) fails on any raw `.from('knowledge_base'|'macros')` `.update/.insert/.upsert/.delete` outside the SDK.

It polices writes only, not reads. The 17 files that already wrote these tables on 2026-11-24 (dashboard KB/macro routes, help-center feedback, the Gorgias importers, `product-intelligence/publish`, …) are grandfathered in its `GRANDFATHERED` set. When you touch one, move its write here and delete it from the set. Never add one. The check prints a note when a grandfathered file no longer writes, so the list only shrinks.

## Backfills that use it

- `scripts/_backfill-tabs-caffeine-support-content.ts` (2026-11-24): corrects Tabs caffeine to 100mg in the article "What is the difference between the Superfood Tab flavors?" and in 7 macros (Tabs: flavors / All Ages / Caffeine?; both "Do you offer tea?"; Coffee & Tabs?; Coffee Too Much Caffeine). It also removes non-compliant copy in those rows: "detox tablets", the turmeric "most effective supplement … boosts weight loss" line, "beneficial at any age", "perfect for everyone", and the immune/gut claims. Anchored find→replace on text and HTML: drifted rows are skipped and reported, and re-runs are no-ops.
- `scripts/_backfill-tabs-dosing-support-content.ts` (2026-11-24): aligns Tabs dosing with the CEO ruling (one tab in 16–20 oz of water, up to 3 a day) in the main "Superfood Tabs" article, "When should I take my Superfood Tabs?", the active "Superfood Tabs - How to Use" macro, and 7 inactive dosing drafts. It also replaces "a low dose of green-tea caffeine" with 100mg in the main article. Reuses `applyPairs` from the caffeine backfill, and NULL HTML stays NULL.

## Related

[[../tables/knowledge_base]] · [[../tables/macros]] · [[../inngest/kb-embed]] · [[rag]] · [[kb-chunker]] · [[policies]] (the sibling chokepoint for policy text) · [[ship-time-backfill-detector]]
