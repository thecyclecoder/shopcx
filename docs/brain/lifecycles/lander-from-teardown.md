# Lifecycle: lander from teardown (Rhea → Cleo → Carrie → founder → build)

The end-to-end trace of the **Acquisition Research Engine**'s last mile. Starts with a competitor lander Rhea captured and Cleo judged worth adapting. Ends with a new addressable storefront lander wired as an ad destination — the same `?variant=` shape our existing landers use ([[advertorial-landers]]), authored automatically once the bucket is whole. Five hand-offs, every one deterministic + supervisable: no session runs unsupervised, and every step surfaces its rationale on the row it wrote.

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] · **Build owner (submission handoff):** [[../functions/platform]]

**Code:**
- Rhea (teardown recipe): [[../libraries/research-urls]] (`setTeardown`, `listNewTeardowns`, `markTeardownReviewed`).
- Cleo (blueprint decision): [[../libraries/cleo-blueprint]] (`runCleoBlueprintSweep`, `decideBlueprintForTeardown`, `adaptSkeletonFromTeardown`) → writes via [[../libraries/lander-blueprints]] `createBlueprint`.
- Carrie (DR content): [[../libraries/lander-blueprints]] (`setBlueprintContent`, `writeCategorizedProductMedia`, `openContentGap`) driven by the box worker's `dr-content` job.
- Founder upload surface: [[../dashboard/marketing__lander-content]] + `src/app/api/marketing/landers/gaps/[id]/upload/route.ts` + `src/app/api/marketing/landers/blueprints/route.ts`.
- Verify + build-spec handoff: [[../libraries/blueprint-build-submit]] (`verifyAndSubmitBlueprint`, `verifyBlueprintBucket`, `composeBuildSpec`, `runBlueprintBuildSubmitSweep`).
- Cadence backstop: [[../inngest/blueprint-build-submit-cron]] (daily 11:15 UTC).
- Author-spec chokepoint: [[../libraries/author-spec]] `authorSpecRowStructured`.

**Tables:** [[../tables/research_urls]] · [[../tables/lander_blueprints]] · [[../tables/lander_content_gaps]] · [[../tables/product_media]] · [[../tables/products]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../tables/agent_jobs]] · [[../tables/storefront_experiments]].

## Flow

### Phase 1 — Rhea captures + judges the source teardown ([[research-and-heal]] cousin)
Rhea (the URL sensor) captures a competitor lander (screenshots + `capture_ref`), classifies it (`advertorial | quiz | pdp | homepage | spam`), and — on a worthy verdict — reverse-engineers it into a structured `TeardownRecipe` (architecture + reason_sequence + levers + offer + transferable_pattern). Persists via [[../libraries/research-urls]] `setTeardownVerdict('worthy')` + `setTeardown(recipe)`. The teardown SETS the vocabulary Cleo diffs against (Rhea's `funnel_type` is FREE-TEXT on purpose — Cleo's mapping is fuzzy). Row: [[../tables/research_urls]].

### Phase 2 — Cleo decides modify-vs-build-new
Cleo's deterministic sweep ([[../libraries/cleo-blueprint]] `runCleoBlueprintSweep`) reads [[../libraries/research-urls]] `listNewTeardowns`, picks a target product ([[../libraries/cleo-blueprint]] `pickTargetProduct` — first active product; extensible), loads the product's existing [[../tables/storefront_experiments]] `lander_type` set, and calls `decideBlueprintForTeardown` per teardown:

- **Single reversible lever** (we already have a matching-funnel-type lander for this product) → route to Cleo's existing bandit path (unchanged). No blueprint is created; [[../libraries/research-urls]] `markTeardownReviewed` drops the row out of the queue.
- **Whole missing funnel type** (we can't render this funnel at all, or we have no matching lander for this product) → author a [[../tables/lander_blueprints]] row via [[../libraries/lander-blueprints]] `createBlueprint` carrying the `transferable_pattern` adapted into `skeleton` (see `adaptSkeletonFromTeardown` — preserves Rhea's `architecture[]` order, folds in `reason_sequence`), status `content_in_progress`, plus a rationale. Then enqueues Carrie's `dr-content` [[../tables/agent_jobs]] job carrying the blueprint id (deduped) and marks the teardown reviewed. Full flow in [[../specs/cleo-lander-blueprint]] (folded).

### Phase 3 — Carrie's DR content pass (the last leash before ops)
Carrie's `dr-content` box job (see [[../libraries/lander-blueprints]] callers) reads the blueprint's skeleton + the product's existing categorized [[../tables/product_media]] and writes copy per skeleton block via `setBlueprintContent`. For every image slot she generates what SHE can (`writeCategorizedProductMedia` with `source='generated'` for hero / ingredient / lifestyle / mechanism roles), and for every REAL-EVIDENCE role — before/after, UGC selfie, testimonial photo, press logo — she opens a [[../tables/lander_content_gaps]] row via `openContentGap` describing what the founder should upload (plain language, no jargon). When done:

- Zero open gaps → [[../libraries/lander-blueprints]] `setBlueprintStatus('content_complete')`.
- One or more open gaps → `setBlueprintStatus('awaiting_upload')`.

The never-fake-a-customer-result line lives here — see [[../libraries/lander-blueprints]] `REAL_EVIDENCE_CATEGORIES`. Full flow in [[../specs/carrie-dr-content]] (folded).

### Phase 4 — Founder upload → product intelligence
`awaiting_upload` blueprints surface on [[../dashboard/marketing__lander-content]] (owner-gated, badge on the sidebar). Per open gap the founder drops a file; the route:

1. Uploads the bytes to the `product-media` bucket at `products/<product_id>/lander-gap/<gap_id>-<stamp>.<ext>`.
2. Upserts a categorized [[../tables/product_media]] row via [[../libraries/lander-blueprints]] `writeCategorizedProductMedia` (`slot='lander-gap-<gap_id>'`, `category=<gap.asset_role>`, `source='uploaded'`, caption + alt) — the asset becomes PERMANENT product intelligence, reusable across future landers.
3. Resolves the gap via `resolveContentGap` (`status='resolved'`, `resolved_media_id`).
4. When it's the LAST open gap on the blueprint, advances the row to `content_complete` + inline-calls the Phase 5 verify+handoff.

Files: `src/app/api/marketing/landers/gaps/[id]/upload/route.ts` · `src/app/dashboard/marketing/landers/content/page.tsx`.

### Phase 5 — Deterministic verify + build-spec handoff to devops
[[../libraries/blueprint-build-submit]] `verifyAndSubmitBlueprint` runs when a blueprint hits `content_complete` (from the founder upload OR the daily cadence — [[../inngest/blueprint-build-submit-cron]]). Deterministic bucket check via `verifyBlueprintBucket`:

- Every `skeleton.blocks[i].role` has non-empty `content.blocks[i].copy`.
- Every image-slot block (roles matching `before_after`/`ugc`/`testimonial`/`press`/`hero`/`image`/`photo`) is covered — either a RESOLVED [[../tables/lander_content_gaps]] row on that `block_ref`, or a categorized [[../tables/product_media]] row keyed to the block's inferred asset_role.

**PASS** → `composeBuildSpec` builds a growth-owned lander BUILD [[../tables/specs]] parented to Growth's "Ad-matched landing pages" mandate (`parentKind:'mandate'`, `parentRef:'growth#ad-matched-landing-pages'` — perpetual acquisition work, not a finite goal milestone) with three phases: render the skeleton on the storefront (using the storefront-optimizer-agent surfaces — same `?variant=` shape as [[advertorial-landers]]), owner-gated preview + [[../tables/storefront_experiments]] wiring, first-render QA + fold to brain. Authored through [[../libraries/author-spec]] `authorSpecRowStructured` (owner `growth`, in_review — Vale reviews, then Ada dispositions, then Bo builds). Blueprint flips to `build_submitted` via [[../libraries/lander-blueprints]] `setBlueprintBuildSubmission` (atomic write of status + `build_spec_slug` link back).

**FAIL** → revert to `awaiting_upload` + re-open a [[../tables/lander_content_gaps]] row for every missing image slot (Carrie's missing-copy deficits re-queue via the `awaiting_upload` transition — a missing-copy gap here would confuse the founder surface). Never authors a spec.

### Phase 6 — Ada dispositions + Bo builds (unchanged build pipeline)
The authored spec enters the normal build pipeline — Vale reviews it, Ada auto-approves or hand-offs, Bo builds one phase per commit onto `claude/build-<spec>`. Same discipline as every other spec on the roadmap. When the render + preview + QA phases ship, the lander is live at `?variant=<funnel>` on the storefront and points from ad destinations.

## The `build_spec_slug` link

Phase 5's `setBlueprintBuildSubmission` writes the slug of the authored spec onto [[../tables/lander_blueprints]] (`build_spec_slug` column; partial index for reverse lookups). That's the round-trip visibility — a reader on the blueprint jumps to the build spec (and its Ada disposition, its PR, its Bo commits), and a reader on the spec can trace back to the source blueprint (and thus to the source teardown). Migration: `supabase/migrations/20260907120000_lander_blueprints_build_spec_slug.sql`.

## Decisions / gotchas

- **Deterministic all the way down.** Every hand-off (Rhea → Cleo, Cleo → Carrie, Carrie → founder, founder → verify, verify → author-spec) is DETERMINISTIC — no Anthropic API on the critical path once Rhea's teardown lands. The one judgment step (`decideBlueprintForTeardown`) is a pure function over the teardown + the product's `lander_type` set; the verify step (`verifyBlueprintBucket`) is a pure function over the blueprint + gaps + product_media.
- **Chokepoint discipline.** Writes to [[../tables/lander_blueprints]] / [[../tables/lander_content_gaps]] / the DR columns on [[../tables/product_media]] go through [[../libraries/lander-blueprints]]; writes to [[../tables/specs]] + [[../tables/spec_phases]] go through [[../libraries/author-spec]] `authorSpecRowStructured`. No raw `.from(...).insert|update|upsert` on any of those tables anywhere else in the codebase.
- **Never-fake-a-customer-result.** [[../libraries/lander-blueprints]] `REAL_EVIDENCE_CATEGORIES` (before_after · ugc · testimonial_photo · press_logo) MUST always come through `source='uploaded'` (the founder) — Carrie is contractually forbidden from generating one with Nano Banana Pro. The verify+handoff never DOWNGRADES this: an image slot Carrie asked the founder for that never gets uploaded stays as an open gap forever (the row reverts to `awaiting_upload`; a spec is NEVER authored under an unresolved real-evidence gap).
- **Product intelligence is reusable.** An uploaded before/after for Amazing Coffee lives at [[../tables/product_media]] with `category='before_after'` + `source='uploaded'` FOREVER — the NEXT teardown Cleo blueprints for the same product will find it via [[../libraries/lander-blueprints]] `listCategorizedProductMedia` and skip the gap entirely. The upload surface is the one-time bridge; the product_media row is the durable asset.
- **Event + cadence.** The founder upload triggers the verify+handoff INLINE (the last-gap resolve — see the route). The cadence is BELT-AND-SUSPENDERS ([[../inngest/blueprint-build-submit-cron]] — daily at 11:15 UTC) — if the inline call hiccuped (a spec-authoring API blip), the cron sweeps every `content_complete` row and drives it through the SAME `verifyAndSubmitBlueprint` code path. Idempotent — a `build_submitted` row is a no-op.
- **cacheComponents.** The founder upload page reads dynamic workspace-scoped data via `useWorkspace()` + client fetches — the segment layout wraps children in `<Suspense fallback={null}>` so the production `next build` doesn't fail on the "Uncached data accessed outside of <Suspense>" prerender guard.

## Status / open work

**Shipped:** content-upload-and-lander-build (all three phases). Phase 1 = the founder upload surface + product_media persistence. Phase 2 = the deterministic verify + author-spec handoff + cron backstop. Phase 3 = this brain page + [[../dashboard/marketing__lander-content]] + brain:index reconcile.

**Finished blueprints (source teardown → blueprint → build spec → live URL):** the concrete evidence the pipeline works end-to-end. Each row is one worthy teardown that survived Cleo's decision → Carrie's content pass → Ada/Bo's build → the storefront-optimizer wiring.

| Blueprint | Product | Funnel | Source teardown | Build spec | Live URL |
|---|---|---|---|---|---|
| `23e0ea01-fea1-4aa2-90f3-bad2d856f654` | Amazing Coffee (`amazing-coffee`) | `advertorial-listicle` → `listicle` via [[../libraries/cleo-blueprint]] `mapFunnelTypeToLanderType` | Erth `/reasons` (superfood-coffee competitor) — recorded on [[../tables/research_urls]] | [`../specs/lander-build-advertorial-listicle-amazing-coffee-23e0ea01`] — parented to Growth's Ad-matched landing pages mandate ([[../functions/growth]]); built by Ada/Platform in three phases (render → owner-gated preview + [[../tables/storefront_experiments]] wiring → this QA + fold). Wiring row inserted by `scripts/wire-blueprint-lander-experiment.ts --apply` (`lever='blueprint-baseline'`, `status='draft'` until the founder promotes to `running`). | `?variant=advertorial-listicle` on the Amazing Coffee PDP (snapshotted onto `lander_blueprints.content.rendered_url` via `scripts/qa-and-snapshot-blueprint-render.ts --apply`). Owner-gated preview at `?variant=advertorial-listicle&preview=1` ([[../libraries/blueprint-preview-gate]]); non-owner is 403'd until the paired [[../tables/storefront_experiments]] row flips to `running`/`promoted`. |

Cross-links for the round trip: [[../libraries/lander-blueprints]] owns the blueprint chokepoint + the new `setBlueprintRenderedUrl` snapshot write; [[../libraries/blueprint-render]] resolves each block's copy + image URL for the storefront reader; [[../libraries/blueprint-render-qa]] carries the Phase-3 QA predicate (byte-identical copy, no broken images, structural parity); [[../libraries/blueprint-experiment-wiring]] stands up the baseline campaign row so [[../libraries/storefront-optimizer-agent]] + [[../libraries/storefront-campaign-grader]] see the new lander. `lander_blueprints.build_spec_slug` closes the loop from either side (spec ↔ blueprint).

**Known gaps / not yet shipped:**
- The build spec's Phase 1 (render the skeleton on the storefront) still needs Ada + Bo to build the actual `?variant=` renderer per lander — the current storefront-optimizer-agent surfaces cover `advertorial | beforeafter | reasons` variants ([[advertorial-landers]]) plus the newly-added `advertorial-listicle` blueprint branch ([[../libraries/blueprint-render]] + `BlueprintLander` section); a new blueprint funnel type will need its own render branch (or extend the generic block-by-block renderer if the layout is a superset of an existing one).
- A richer category → product mapping (Cleo's `pickTargetProduct` picks the first active product today; a future teardown-brand → product-tag mapping is a Phase 3+ refinement of [[../specs/cleo-lander-blueprint]]).
- Auto-close a blueprint whose source teardown got purged (`research_url_id` ON DELETE SET NULL leaves an orphan blueprint pointing at nothing; Cleo could sweep + `rejected` these on the same cron).

**Open questions:** None.

## Related

[[advertorial-landers]] · [[creative-finder]] · [[ad-render]] · [[ad-publish]] · [[../libraries/lander-blueprints]] · [[../libraries/blueprint-render]] · [[../libraries/blueprint-render-qa]] · [[../libraries/blueprint-preview-gate]] · [[../libraries/blueprint-experiment-wiring]] · [[../libraries/cleo-blueprint]] · [[../libraries/blueprint-build-submit]] · [[../libraries/research-urls]] · [[../libraries/author-spec]] · [[../libraries/storefront-optimizer-agent]] · [[../libraries/storefront-campaign-grader]] · [[../inngest/blueprint-build-submit-cron]] · [[../dashboard/marketing__lander-content]] · [[../dashboard/marketing__landers]] · [[../tables/lander_blueprints]] · [[../tables/lander_content_gaps]] · [[../tables/product_media]] · [[../tables/research_urls]] · [[../tables/storefront_experiments]] · [[../tables/specs]] · [[../functions/growth]] · [[../functions/platform]] · [[../goals/acquisition-research-engine]]
