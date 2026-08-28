# migration-fix.ts

`src/lib/migration-fix.ts` — the **queue plumbing + deterministic executor** behind the **migration-fix box agent** ([[../specs/migration-fix-agent]]). North star (supervisable autonomy): a `failed` [[../tables/migration_audits]] row is a renewal at risk; the box session DIAGNOSES read-only and PROPOSES a typed fix; the **worker** (the only component that mutates) executes the approved plan HERE — never freestyle DB writes, never a silent re-bill — then re-runs `verifyMigration`. Only a re-`passed` audit clears.

## Exports

- **`enqueueMigrationFixJob(admin, { auditId, subscriptionId, workspaceId }) → { enqueued, reason? }`** — insert a `kind='migration-fix'` [[../tables/agent_jobs]] row (`spec_slug = auditId`, `instructions = {audit_id, subscription_id}`). **Idempotent + best-effort:** no-op if an active migration-fix job already exists for the audit. Called inline by [[migration-audit]] `verifyMigration`→`finalize()` on the TRANSITION to `failed` (**event-driven — there is no migration-fix cron**).
- **`applyMigrationFix(admin, audit, action) → { ok, detail }`** — run ONE owner-approved typed fix against prod. Idempotent where possible. The worker (`runMigrationFixJob`) calls it per `approved` action, then re-runs `verifyMigration(auditId)`.
- Types: `MigrationFixKind = 'price_reconcile' | 'variant_backfill' | 'appstle_cancel' | 'shipping_protection_convert' | 'remove_line'`; `PriceReconcilePayload` · `VariantBackfillPayload` · `AppstleCancelPayload` · `ShippingProtectionConvertPayload` · `RemoveLinePayload`.
- **Verdict vocabulary**: `MigrationFixVerdict = 'propose' | 'needs_input' | 'human_needed' | 'code_gap'` + the runtime array `RECOGNIZED_MIGRATION_FIX_VERDICTS` + the type-guard `isRecognisedMigrationFixVerdict(status)` — the four terminal outcomes a migration-fix box session may end with. Consumed by `runMigrationFixJob` in `scripts/builder-worker.ts` so a well-formed `code_gap` is a REPORTED terminal outcome (see "Accepted verdict vocabulary" below), not a fallthrough into `needs_attention`.

## Accepted verdict vocabulary

A migration-fix box session ends with one of exactly four `status` values in its final JSON. The worker branches on each; the fallback branch names the full vocabulary in its error string so a future gap fails loudly rather than silently parking the row as `needs_attention` with the session's diagnosis stranded in the log tail (the 2026-08-18 anti-pattern this vocabulary pins down — a session that had correctly emitted `code_gap` ended `error='migration-fix ended without propose/human_needed'` because the fallback branch predated the `code_gap` handler).

| verdict | Meaning | Worker action |
|---|---|---|
| `propose` | The box computed one or more typed `MigrationFixKind` fix actions the owner can approve on [[../dashboard/migrations]]. | Persist as `pending_actions` → `status='needs_approval'`; on approval, run `applyMigrationFix` per action then re-run `verifyMigration(auditId)`. |
| `needs_input` | The box needs the owner to answer ONE plain-language judgment question inline (see [[../specs/migration-fix-human-input]]). | Park on `status='needs_input'` with `questions [{id,q}]`; the owner's answer via `POST /api/roadmap/answer` resumes the same Max session. |
| `human_needed` | The failure needs a human, out-of-system action (e.g. no billable card anywhere in the link group). The box has written the diagnosis. | `status='completed'`, `error='human-needed'`; the audit stays `failed` with the diagnosis on the dashboard. |
| `code_gap` | The failure needs CODE, not data — a RECURRING code/data gap the box has recognized. The box authors a permanent fix spec (`public.specs` + `public.spec_phases` via the author-spec SDK, surfaced on Roadmap). | `status='completed'`, `error='code-gap'`; the diagnosis + authored spec slug ship in the `log_tail`. This sub still needs a hand for now, so the audit stays `failed`; the spec fixes the CLASS on its next build. |

A well-formed `code_gap` is a TERMINAL, REPORTABLE outcome — never a "ended without propose/human_needed" park. The 2026-08-18 anti-pattern (a park backstop that told the founder "you can't fix this from this card" while discarding the session's real finding) is removed by this vocabulary.

## The five fixes (the judgment auto-heal punts)

| `fix_kind` | Payload | What `applyMigrationFix` does |
|---|---|---|
| `price_reconcile` | `{ overrides: [{ variant_id (catalog UUID), price_override_cents }] }` | Sets `subscriptions.items[].price_override_cents` for each matched grandfathered line so the engine subtotal ≈ `pre_migration_charge_cents`. Validates each override is a positive int ≤ `MAX_OVERRIDE_CENTS` ($1000). **Base ≤ MSRP invariant**: looks up each line's `product_variants.price_cents` (MSRP) and **clamps any proposed override DOWN to MSRP** — the agent can NEVER reconcile a sub *upward* past list (the `detail` notes `clamped N to MSRP`). The real gate is the post-fix re-verify. See [[../specs/base-price-never-above-msrp]]. |
| `variant_backfill` | `{ variant: { product_id, shopify_variant_id, title?, sku?, price_cents?, option1-3? }, item_match: { shopify_variant_id?, sku? } }` | Inserts the missing [[../tables/product_variants]] row (idempotent — reuses an existing row for that Shopify id), then remaps the matched sub item onto the new UUID + `product_id`. **Never loosens the `items_on_uuids` check** — backfills the row. The fix the 2026-06-10 incident did by hand. |
| `appstle_cancel` | `{ appstle_contract_id?, reason? }` | `appstleSubscriptionAction(workspaceId, <old contract id>, 'cancel', reason, 'ShopCX migration-fix')` — cancels the lingering Appstle contract (double-bill risk). |
| `shipping_protection_convert` | `{ amount_cents, baseline_cents }` | Converts a migrated Appstle "Shipping Protection" line into the internal flag: sets `subscriptions.shipping_protection_added=true` + `shipping_protection_amount_cents=amount_cents`, removes the protection line from `items[]` (real product lines + their overrides left **untouched** — **never raises a product override**), and corrects the audit's `pre_migration_charge_cents` to `baseline_cents` (the product-only subtotal the line had inflated). Idempotent. The repair for subs migrated **before** [[migrate-to-internal]] learned to convert protection at migrate time — the `pricing_preserved` overage equals the protection line. First use: sub `4b831caa` (amount 375, baseline 6371→5996, Tabs override left at 5996). |
| `remove_line` | `{ line_id?, shopify_variant_id?, title? }` (≥1; matches only a line satisfying **every** field provided) | Deletes a **FREE/promo line** that the old migration dragged across (a $0 add-on with **no catalog identity** — no `product_variants` row) from `items[]`, leaving every other line + its `price_override_cents` **untouched**. The `items_on_uuids` repair for a line we want **gone** (vs `variant_backfill`, which **keeps** a real product by inserting its missing row). Idempotent (no-op once gone); fail-closed if a match would empty the whole sub. First use: sub `e4589de9` (the free `ACV Gummies` line), composed with `shipping_protection_convert`. See [[../specs/migration-fix-remove-line]]. |

`card_pinned` / no billable card has **no fix** — it's **out-of-system** (the customer must act), so the box surfaces terminal `human_needed` with a **one-line plain instruction** (never invents a card).

## Human-judgment pause + inline answer ([[../specs/migration-fix-human-input]])

When a failing check needs an owner **decision** (not an out-of-system block) — e.g. an ambiguous grandfathered price — the box doesn't dump check-jargon. It pauses the job on **`needs_input`** with **one plain-language question** parked in [[../tables/agent_jobs]]`.questions [{id,q}]`. The owner answers inline on [[../dashboard/migrations]] (`POST /api/roadmap/answer` → `queued_resume`). `runMigrationFixJob` then takes the **answer-resume** path (`answers` present, no approved/declined action): it re-runs the `migration-fix` skill **resuming the same Max session** with the owner's answer baked in, so the box proposes the concrete gated fix (the normal `propose` → `needs_approval` → **Approve & fix** flow). The deterministic executor here (`applyMigrationFix`) is unchanged — the human-input handshake is all in the worker + the skill.

**Code-gap escalation (Phase 2).** When a failure is rooted in a **recurring** code/data gap — a CLASS of missing catalog rows, a pricing-inference edge case `inferAppstleLineBase` structurally can't cover — the box emits `code_gap` with a fix `spec` instead of a per-sub `human_needed`. `runMigrationFixJob` → `authorMigrationGapSpec` (in `scripts/builder-worker.ts`) commits `docs/brain/specs/{slug}.md` to main (owner=`retention`, surfaced on the Roadmap board to commission a build — exactly how [[../specs/box-escalation-triage]] routes analyzer fixes). The slug is a **stable gap-class slug** (not the sub/audit id) and the commit is **idempotent** — if that spec already exists the box leaves the in-flight one rather than spawning a duplicate per sub. The migration still **fails-closed** to a human (job `error='code-gap'`, diagnosis + spec result in `log_tail`); the spec fixes the class, not this renewal.

## Callers

- [[migration-audit]] `verifyMigration` → `enqueueMigrationFixJob` (failure event).
- `scripts/builder-worker.ts` `runMigrationFixJob` → `applyMigrationFix` (on approval) + re-verify.
- `/api/migrations` joins the migration-fix [[../tables/agent_jobs]] row to surface the diagnosis + proposed fix on [[../dashboard/migrations]].

## Gotchas

- **Worker mutates, not the box.** The box session keeps prod secrets to *read* but emits only a proposal; `applyMigrationFix` runs in the worker on the owner's approval (the [[../specs/build-approval-gates|approval-gate]] pattern via [[../tables/agent_jobs]]`.pending_actions`).
- **Re-verify-gated.** A fix "counts" only when `verifyMigration` re-passes; `applyMigrationFix` never touches `migration_audits.status` directly.
- **No re-enqueue loop.** The failure hook fires only on the `failed` transition (prior status ≠ failed) and `enqueueMigrationFixJob` dedupes against an active job — so the resume's re-verify (audit already `failed`) never spawns a second job.
- **Never reconcile above MSRP.** `price_reconcile` clamps a proposed `price_override_cents` down to the line's catalog MSRP (`product_variants.price_cents`); paired with the strict-below-MSRP write guard in [[migrate-to-internal]] this makes `base ≤ MSRP` a true invariant. Stranded over-MSRP overrides from the old code are dropped by `scripts/backfill-drop-over-msrp-overrides.ts`. See [[../specs/base-price-never-above-msrp]].

---

[[../README]] · [[../specs/migration-fix-agent]] · [[migration-audit]] · [[../tables/agent_jobs]] · [[../tables/migration_audits]] · [[../tables/product_variants]] · [[appstle]] · [[../dashboard/migrations]] · [[../recipes/build-box-setup]]
