# Research & Heal — auto-recovery for flagged tickets

## Why this exists

The AI nightly analysis (every 30 min) flags tickets where the AI claimed to do something but maybe didn't (e.g. "I applied your loyalty coupon" with no actual `apply_coupon` action ran), or where state on Shopify/Appstle/Smile disagrees with what the customer was told. Historically a flagged ticket meant a human agent had to pick it up, retrace what happened, and clean up.

Most of those cleanups are **mechanical**: re-run a missing action, backfill a missing DB row, refund the gap, message the customer. The verification of "did X really happen?" is deterministic — no AI judgment required. So we split it:

- **AI analysis** decides _what kind_ of problem this is (free-text → recipe slug).
- **Research recipe** (code, not AI) checks the OG source of truth + our DB and produces a structured `ResearchResult` with `findings` and `gaps`.
- **Heal** is the proposed corrective action attached to each gap. Manual one-click in Phase 1; auto-execute by allowlist in Phase 2.

The customer experience goal: an agent only gets pulled in when everything else fails.

## Architecture

```
ai_nightly_analysis (cron, every 30 min)
   ↓ low score + matches a known pattern
emits research_requests: [{recipe_slug, args}]
   ↓
Inngest: ticket/research.requested
   ↓
runRecipe(slug, ticketId, args) → ResearchResult
   ↓
persist to ticket_research_runs
   ↓
gaps surfaced on ticket detail page + AI analysis page

   ↓ admin clicks "Heal this gap" (Phase 1)
   ↓ OR allowlist auto-triggers (Phase 2)
ticket/heal.requested
   ↓
re-run recipe → verify gap still exists
   ↓ if yes:
execute proposed_heal.action via the existing action-executor
   ↓ on success:
re-run recipe → verify gap closed
   ↓
send Suzie-signed customer follow-up (from gap's customer_message_template)
   ↓
unescalate + close ticket
persist to ticket_heal_attempts
```

## Recipe interface

Every recipe lives at `src/lib/research/recipes/<slug>.ts` and exports a `ResearchRecipe` object.

```typescript
interface ResearchRecipe {
  slug: string;            // stable identifier — used by AI analysis to request
  version: number;         // bump when the logic changes; old runs aren't trusted as current
  description: string;     // shown in the analyzer + admin docs
  run: (ticketId: string, args?: Record<string, unknown>) => Promise<ResearchResult>;
}

interface ResearchResult {
  findings: Finding[];   // observed state, surfaced even when no gap exists
  gaps: Gap[];           // problems requiring a fix
}

interface Finding {
  type: string;                // e.g. "coupon_applied_correctly"
  subject: string;             // e.g. "LOYALTY-15-JB8MTS"
  evidence: Record<string, unknown>;
  severity: "info" | "low" | "medium" | "high";
}

interface Gap {
  gap_id: string;              // stable id within this run (e.g. "missing_coupon:33484669101")
  description: string;
  severity: "low" | "medium" | "high";
  proposed_heal?: {
    action_type: string;       // matches a key in action-executor's directActionHandlers
    params: Record<string, unknown>;
    customer_message_template: string;   // mustache-style placeholders ({{coupon_code}}, etc.)
    customer_message_persona: "suzie" | "julie";
  };
}
```

### Recipe rules

1. **Always check the OG source of truth.** Our DB can be stale (Jennell's missing `subscriptions` rows hid the whole problem until we hit Appstle directly). Recipes default to fetching live from Shopify / Appstle / Smile / EasyPost and treat our DB as a cache only.

2. **Return both `findings` and `gaps`.** Findings = "here's what I saw"; gaps = "here's what needs fixing." Findings should always populate even when no gap exists — the analyzer page surfaces them as audit context.

3. **Gaps include the exact heal payload.** The `proposed_heal.action_type` + `params` go straight to `executeDirectAction` with no further AI hop. The customer message template is the post-heal follow-up.

4. **Recipes can compose.** A recipe can call other recipes' internal helpers (factor common probes — like "get all loyalty coupons for this customer with Shopify usage counts" — into the `research/probes/` folder, not into the recipes themselves).

5. **Stable `gap_id`.** Use deterministic strings so the same gap on the same ticket produces the same id across re-runs. This is how the anti-loop guard knows we've already healed this gap.

## Heal flow

The heal step is **separate** from research and only runs on an explicit gap.

```
heal(ticket_id, research_run_id, gap_id, options: { autoTriggered: boolean })
  1. Idempotency check: is there already a successful heal_attempt for this gap_id on this ticket?
     → if yes, return existing
  2. Re-run the recipe → verify the gap is still present
     → if no, mark heal as "verified_closed_pre_heal" and return
  3. Anti-loop guards (only enforced for autoTriggered=true; manual button bypasses):
     - customer hasn't replied since the research run
     - agent_intervened != true
     - this gap_id hasn't already failed a heal on this ticket
     - ticket is < 7 days old
  4. Execute the gap's proposed_heal via executeDirectAction
  5. Re-run the recipe → verify the gap closed
     → if still open, mark heal as "verified_still_open", escalate
  6. Send customer follow-up using customer_message_template
  7. Unescalate + close ticket
  8. Persist final state to ticket_heal_attempts
```

### Auto-heal allowlist (Phase 2)

Auto-heal triggers ONLY when (recipe_slug, gap_type, heal_action_type) is on the allowlist:

| Recipe | Gap | Heal action | Why safe |
|---|---|---|---|
| `verify_coupon_promises` | `missing_coupon_with_unused_available` | `apply_loyalty_coupon` | Coupon already exists in Shopify, just apply to the sub. Reversible by `remove_discount`. |
| `verify_coupon_promises` | `missing_coupon_with_points_available` | `redeem_points → apply_loyalty_coupon` | Creates a fresh coupon + applies. Refundable via `restore_points` if it's wrong. |
| `verify_replacement_promises` | `missing_replacements_row` | backfill row | DB-only fix. Doesn't touch Shopify. |
| `verify_sub_action_executed` | `change_next_date_not_executed` | `change_next_date` | Idempotent — re-running with the same date is a no-op. |

NOT on the allowlist (always escalate):
- Refund-related gaps (auto-refunds without re-checking policy is dangerous)
- Replacement order creation (creating a Shopify order autonomously is high-blast-radius)
- Cancellation actions (one-way doors)
- Anything where the customer is upset / has been waiting > 24h

Expand the allowlist gradually as Phase 1 surfaces the false-positive rate per recipe.

## Adding a new recipe

1. Pick a slug (snake_case, verb_object): `verify_refund_issued`, `check_grandfathered_pricing`.
2. Add `src/lib/research/recipes/<slug>.ts` exporting a `ResearchRecipe`.
3. Register in `src/lib/research/index.ts`'s `RECIPE_REGISTRY`.
4. Add the AI analysis prompt to "when should this recipe be requested?" so the nightly analyzer learns to call it.
5. Manually run on 5-10 known-bad tickets to validate findings + gaps.
6. After a week of clean Phase 1 results, propose the heal combo for the Phase 2 allowlist.

## Recipe catalog

### `verify_coupon_promises` (shipped Phase 1)
Parses the most recent AI/agent message on the ticket for promised coupon codes / promised "applied to your subscription" claims. Verifies each against:
- `subscriptions.applied_discounts` on each of the customer's active subs (DB) AND
- Shopify GraphQL `codeDiscountNodes` for `asyncUsageCount` (OG truth — catches the "DB says applied but the code is consumed/expired" edge)

Gaps:
- `missing_coupon:{contract_id}` — promised X subs got coupons, but contract Y has none. Proposed heal = pick an unused LOYALTY coupon for this customer (or redeem if none unused) and apply.
- `applied_coupon_already_used:{contract_id}` — sub has a coupon applied per our DB, but Shopify says usage_count=1. Proposed heal = redeem fresh + replace.

### `verify_replacement_promises` (planned Phase 1)
Looks for "your replacement is on the way" claims in recent messages. Verifies:
- `replacements` row exists for this ticket (DB) AND
- Shopify draft order / order exists (OG truth — catches Eric's case)

### `verify_subscription_changes` (shipped Phase 1)
The big one. Parses the most recent AI/agent messages on the ticket for ANY claim that touched a subscription, and verifies the live Appstle state matches. Covers:

  - **Pause** — "I've paused your subscription until Aug 15" → Appstle contract.status == "PAUSED" AND pause_resume_at matches the claimed date
  - **Resume** — "I've reactivated your subscription" → contract.status == "ACTIVE"
  - **Skip next order** — "I've skipped your next shipment" → next billing is the one after the skipped one (or the upcoming order is marked skipped)
  - **Change next billing date** — "Your next order will ship on X" → contract.nextBillingDate matches (within tolerance — same calendar day)
  - **Change frequency** — "Switched you to every 2 months" → contract.billingPolicy interval/intervalCount matches
  - **Swap variant** — "Switched to Peach Mango" → contract has a line with the target variant_id
  - **Remove item** — "Removed ACV Gummies from your sub" → variant not on the contract anymore
  - **Add item** — "Added X to your sub" → variant present on the contract
  - **Update line item price** — "Restored your $30/box pricing" → line item base_price matches
  - **Cancel** — "I've cancelled your subscription" → contract.status == "CANCELLED"
  - **Apply / remove discount** — covered by `verify_coupon_promises`

Each individual claim → one finding (correct) or one gap (mismatch). Gaps propose the exact direct_action that should have run (e.g. `change_next_date` with the claimed date as params), so heal is a one-call replay of what the AI _said_ it did.

This recipe alone catches the majority of "AI lied silently" patterns we see.

### `verify_grandfathered_pricing` (shipped Phase 1 — proactive)
Doesn't need an AI claim to trigger. Walks the customer's active subs and, per line item, compares the current `price_cents` against the customer's full historical order pattern for that variant (across linked accounts, up to last 100 orders). Builds a frequency map; the most common historical price (tie-broken to the lowest) is the customer's "typical" rate.

If `current_cents − typical_cents` exceeds **$4/box** AND **5%**, emits a `pricing_drift:{contract_id}:{variant_id}` gap. The proposed heal is `update_line_item_price` with `base_price_cents = typical_cents / 0.75` (Appstle applies the 25% sellingPlan discount → customer pays the historical rate at next renewal).

Heal proposal is gated: requires at least **3 confirming occurrences** of the typical price to rule out one-off discount events or returns. Below that threshold the gap is still surfaced but with no `proposed_heal` → escalates for agent review.

Catches Nancy-style and Sheryl-style drift where the customer paid one rate for years and now sees a higher renewal — without anyone having to remember to check.

### `verify_refund_issued` (future)
"$X refund is on its way" → Shopify order refunds list for matching amount.

### `verify_return_label_sent` (future)
"You'll receive a return label" → `returns` table with `label_url` populated + email_events for delivery.

### `check_loyalty_state` (composed helper)
Points balance, unused vs applied coupons (verifying via Shopify `asyncUsageCount` — our `status` column is stale). Used by other recipes.

## Database schema

```sql
ticket_research_runs (
  id UUID PK,
  workspace_id UUID,
  ticket_id UUID,
  recipe_slug TEXT,
  recipe_version INT,
  ran_at TIMESTAMPTZ,
  findings JSONB,
  gaps JSONB,
  triggered_by TEXT,         -- 'ai_analysis' | 'manual' | 'auto_heal_reverify'
  source_analysis_id UUID    -- if triggered by ai_analysis
);

ticket_heal_attempts (
  id UUID PK,
  workspace_id UUID,
  ticket_id UUID,
  research_run_id UUID,
  gap_id TEXT,
  action_type TEXT,
  action_params JSONB,
  status TEXT,               -- 'verified_existing' | 'executed' | 'failed' | 'verified_closed' | 'verified_still_open' | 'skipped_idempotent'
  result JSONB,
  error TEXT,
  customer_message_sent BOOLEAN DEFAULT false,
  attempted_at TIMESTAMPTZ,
  attempted_by UUID          -- user_id for manual heal, null for auto
);
```

## Conventions

- **Recipes return `findings` even when there are no gaps.** Surfaces audit context — useful to know that we did look and everything was clean.
- **The `proposed_heal.action_type` MUST be a known direct action.** No new action types invented inside recipes — if you need a new action, add it to `action-executor.ts` first.
- **Never call recipes in tight loops.** The Appstle and Shopify API rate limits are real. Recipes should aggressively cache their own probes within a single run.
- **Heal customer messages always include the OUTCOME, not the gap.** Don't say "we noticed we hadn't applied your coupon" — say "your $15 coupon is now on order X, deducted at next renewal." The customer doesn't need to know we caught our own mistake.

## Files

| File | Purpose |
|---|---|
| `src/lib/research/index.ts` | Recipe registry + runRecipe() entry point |
| `src/lib/research/recipes/<slug>.ts` | Individual recipes |
| `src/lib/research/probes/` | Shared deterministic probes (e.g. `loyaltyCouponState.ts`) |
| `src/lib/inngest/ticket-research.ts` | Inngest function for `ticket/research.requested` |
| `src/lib/inngest/ticket-heal.ts` | Inngest function for `ticket/heal.requested` |
| `src/app/api/workspaces/[id]/tickets/[tid]/heal/route.ts` | Manual heal-button endpoint |
| `src/app/dashboard/tickets/[id]/ResearchPanel.tsx` | Ticket detail surface for findings + heal button |
