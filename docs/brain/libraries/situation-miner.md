# `src/lib/situation-miner.ts` — Situation miner (deterministic apply step)

The deterministic **verify-and-screen apply step** for the `situation-mine` box lane. Phase 1 of the "mine customer situations for every advertised product" spec ([[../lifecycles/ai-shopping-agent]]).

**Why it exists.** The AI shopping agent recommends a product by the shopper's life situation via `find_products_for_situation`, but [[../tables/product_customer_situations]] only held hand-seeded Superfood Tabs rows — so a shopper asking for a healthier morning coffee was told about Tabs, never Amazing Coffee. The miner reads each advertised product's best reviews and writes the real situations its customers were in. A model reads reviews well but can paraphrase or invent, so **the model only proposes and this code verifies** before anything is written.

**The model only proposes; this code verifies.** The Max box session (`.claude/skills/situation-mine/SKILL.md`, dispatched by `scripts/builder-worker.ts` `runSituationMineJob`) is the only LLM caller — it reads the reviews and emits `{situations:[…]}`. Nothing it proposes is trusted. `applySituationMine` is the **sole mutator** and the only write path for a mined situation.

## Exports

| Export | Notes |
|---|---|
| `applySituationMine({admin?, workspaceId, productId, mineDateISO, reviews, proposal})` | → `SituationMineResult`. Verifies + screens the box session's proposal and upserts via [[customer-situations]] `upsertSituations`. The only mutator. |
| `MineReview` | `{id, reviewer, rating, verified_purchase, featured, body}` — a best-review handed to the session and re-used here to verify quotes verbatim. |
| `ProposedSituation` / `ProposedQuote` / `SituationMineProposal` | The parsed box-session output shape. |
| `SituationMineResult` | Per-run counts: `proposed · verbatimDropped · complianceDroppedSituations · complianceFlaggedQuotes · storedNonCompliant · skippedSeed · written · rows`. |

## The verify-and-screen gate (the whole point of Phase 1)

For each proposed situation, in order:

1. **Seed protection** — if a `seed:*` row already holds the (normalized) slug for this product, SKIP it (`skippedSeed`). A mine never overwrites a hand-seeded row. (Existing rows loaded via `listSituations(..., {compliantOnly:false})` so seed rows are visible regardless of compliance.)
2. **Situation-text compliance** — run [[shopping-agent]] `checkClaim` on `situation` / `who` / `goal` / `noticed`. If ANY field trips the FDA/FTC structure/function block list, DROP the whole situation (`complianceDroppedSituations`) — a non-compliant framing must never be published even stripped of quotes.
3. **Verbatim quote verification** — each quote's `verbatim_phrase` must be a **case-insensitive substring** of the EXACT body of the review whose `review_id` it cites. Not a substring (or the review wasn't in the set) ⇒ DROP the quote (`verbatimDropped`). No fabricated quotes.
4. **Quote compliance** — run `checkQuote` on each surviving quote (disease/drug terms only; weight-loss results pass — CEO 2026-11-28). A failing quote is STORED with `compliance_ok=false` + a note (kept for audit; the SDK's surface filter strips it) and counted (`complianceFlaggedQuotes`).
5. **Situation-level gate** — a situation with ≥1 compliant quote is stored `compliance_ok=true`; a situation with zero compliant quotes is stored `compliance_ok=false` (`storedNonCompliant`).

Surviving situations upsert through `upsertSituations` on `(workspace_id, product_id, slug)` with `source='mine:<ISO date>'`, `review_ids` = the cited reviews, `verbatim_phrase` = the first compliant quote's phrase.

## Node-completeness trio (CLAUDE.md hard rule)

- **OWNER** — `situation-mine` → `cmo` in [[control-tower-node-registry]] `KIND_OWNER_FALLBACK` (+ `BUILDER_WORKER_KINDS`). The organic-discovery surface (situational recommendations inside AI assistants) is the CMO's mandate.
- **KILL-SWITCH ANCESTRY** — inherits the CMO's ancestry via the node registry (`parentIdForOwner('cmo')` → `director:cmo`), so a `dept:cmo` / `director:cmo` `kill_switches` row cascades to this lane.
- **HEARTBEAT** — `runSituationMineJob` emits `emitAgentHeartbeat('situation-mine', …)` from an end-of-run try/finally so a throw still beats `ok:false`. Per-run counts are logged to the job `log_tail` + stdout so the CMO can supervise the proxy (proposed vs written).

## Enqueue (Phase 2)

The Vercel/script → box handoff lives here too, so idempotency is in ONE place:

| Export | Notes |
|---|---|
| `enqueueSituationMine({workspaceId, productId, admin?})` | Queue ONE job. Idempotent per (workspace, product): skips a queued/running job OR a product mined in the last `SITUATION_MINE_FRESH_DAYS` (7) days. Freshness probe reads through `listSituations` (SDK) — never a raw `.from`. |
| `enqueueSituationMineForAdvertised(admin, workspaceId)` | Enqueue for every `is_advertised` product in a workspace. Returns `{products, enqueued, skippedInflight, skippedFresh, jobIds}`. Shared by the backfill + cron. |
| `workspacesWithAdvertisedProducts(admin)` / `listAdvertisedPreview(admin, workspaceId)` | Fan-out + dry-run helpers. |

## Callers

- `scripts/builder-worker.ts` `runSituationMineJob` — loads one advertised product's title + lead benefits + up to ~300 best reviews, runs the box session, parses `{situations}`, and hands it here.
- `scripts/_backfill-mine-situations-advertised.ts` — tracked ship-time backfill; initial run across the advertised lineup (dry-run by default, `--apply` to enqueue).
- `src/lib/inngest/situation-mine-refresh.ts` `situation-mine-refresh-cron` — monthly re-enqueue so new reviews feed new situations (MONITORED_LOOPS 37d window, owner `cmo`).

## Related

[[customer-situations]] · [[shopping-agent]] · [[../tables/product_customer_situations]] · [[../tables/product_reviews]] · [[advertised-products]] · [[../lifecycles/ai-shopping-agent]]
