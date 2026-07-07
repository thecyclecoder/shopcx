# Research & Heal

Auto-recovery for tickets the AI analysis flagged as suspicious. When the AI claims to have done something but reality disagrees — or when state on Shopify/Appstle/Smile is drifting — recipes verify the gap and either propose or auto-execute a corrective action. The customer experience goal: an agent only gets pulled in when everything else fails.

## Cast

- Pipeline: [[../inngest/ticket-research]] + `src/lib/inngest/ticket-heal.ts`.
- Recipes: `src/lib/research/recipes/*.ts` (one file per recipe).
- Probes: `src/lib/research/probes/*.ts` (shared deterministic state checks).
- Registry: `src/lib/research/index.ts` (`runRecipe(slug, ticketId, args)`).
- State: [[../tables/ticket_research_runs]] + [[../tables/ticket_heal_attempts]].
- Trigger: [[../libraries/ticket-analyzer]] (run by [[../inngest/ticket-analysis-cron]]) emits `ticket/research.requested` on low-score tickets — the old [[../inngest/ai-nightly-analysis]] trigger was removed 2026-07-07.

## Why it exists

The AI nightly analysis (every 30 min) flags tickets where the AI claimed to do something but maybe didn't (e.g. "I applied your loyalty coupon" with no actual `apply_coupon` action ran), OR where state on Shopify/Appstle/Smile disagrees with what the customer was told.

Most of these cleanups are **mechanical**. The verification of "did X really happen?" is deterministic — no AI judgment required. So we split it:

- **AI analysis** decides what kind of problem this is (free-text → recipe slug).
- **Research recipe** (code, not AI) checks the OG source of truth + our DB and produces a structured `ResearchResult` with `findings` and `gaps`.
- **Heal** is the proposed corrective action attached to each gap. Manual one-click in Phase 1; auto-execute by allowlist in Phase 2.

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
   ↓
admin clicks "Heal this gap" (Phase 1) OR allowlist auto-triggers (Phase 2)
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

Every recipe at `src/lib/research/recipes/<slug>.ts` exports a `ResearchRecipe`:

```typescript
interface ResearchRecipe {
  slug: string;            // stable identifier — AI analysis requests by slug
  version: number;         // bump when logic changes; old runs aren't trusted as current
  description: string;     // shown in the analyzer + admin docs
  run: (ticketId: string, args?: Record<string, unknown>) => Promise<ResearchResult>;
}

interface ResearchResult {
  findings: Finding[];   // observed state, surfaced even when no gap exists
  gaps: Gap[];           // problems requiring a fix
}

interface Gap {
  id: string;              // e.g. "missing_coupon:1234" — stable across re-runs
  description: string;
  evidence: Record<string, unknown>;
  proposed_heal?: {
    action_type: string;   // MUST be a known direct action in action-executor.ts
    action_params: Record<string, unknown>;
    customer_message_template: string;
  };
}
```

## Shipped recipes (Phase 1)

### `verify_subscription_changes` — THE big one

Parses the most recent AI/agent messages on the ticket for ANY claim that touched a subscription, and verifies the live Appstle state matches. Covers:

| Claim | Verification |
|---|---|
| **Pause** — "I've paused your subscription until Aug 15" | Appstle contract.status == "PAUSED" AND pause_resume_at matches |
| **Resume** — "I've reactivated your subscription" | contract.status == "ACTIVE" |
| **Skip next order** | Next billing is the one after the skipped one |
| **Change next billing date** — "Your next order will ship on X" | contract.nextBillingDate matches (within same calendar day) |
| **Change frequency** — "Switched you to every 2 months" | contract.billingPolicy interval/intervalCount matches |
| **Swap variant** — "Switched to Peach Mango" | contract has a line with the target variant_id |
| **Remove item** — "Removed ACV Gummies" | variant not on the contract anymore |
| **Add item** — "Added X to your sub" | variant present on the contract |
| **Update line item price** — "Restored your $30/box pricing" | line item base_price matches |
| **Cancel** — "I've cancelled your subscription" | contract.status == "CANCELLED" |
| **Apply / remove discount** | covered by `verify_coupon_promises` |

Each individual claim → one finding (correct) or one gap (mismatch). Gaps propose the exact direct_action that should have run, so heal is a one-call replay of what the AI **said** it did.

This recipe alone catches the majority of "AI lied silently" patterns.

### `verify_coupon_promises`

Checks both [[../tables/subscriptions]].`applied_discounts` (DB) AND Shopify GraphQL `codeDiscountNodes` for `asyncUsageCount` (OG truth — catches the "DB says applied but the code is consumed/expired" edge).

Gaps:
- `missing_coupon:{contract_id}` — promised X subs got coupons but contract Y has none. Heal = pick an unused LOYALTY coupon (or redeem if none unused) and apply.
- `applied_coupon_already_used:{contract_id}` — sub has a coupon applied per our DB but Shopify says usage_count=1. Heal = redeem fresh + replace.

### `verify_grandfathered_pricing` — proactive

Doesn't need an AI claim to trigger. Walks the customer's active subs and, per line item, compares the current `price_cents` against the customer's full historical order pattern for that variant (across linked accounts, up to last 100 orders). Builds a frequency map; the most common historical price (tie-broken to the lowest) is the customer's "typical" rate.

If `current_cents − typical_cents` exceeds **$4/box** AND **5%**, emits a `pricing_drift:{contract_id}:{variant_id}` gap. Proposed heal: `update_line_item_price` with `base_price_cents = typical_cents / 0.75` (Appstle applies the 25% sellingPlan discount → customer pays the historical rate at next renewal).

Gated: requires at least **3 confirming occurrences** of the typical price to rule out one-off discount events. Below threshold, gap is surfaced but with no `proposed_heal` → escalates for agent review.

Catches Nancy-style and Sheryl-style drift.

## Planned recipes

- `verify_replacement_promises` — "Your replacement is on the way" → [[../tables/replacements]] row + Shopify draft order. Catches Eric's case.
- `verify_refund_issued` — "$X refund is on its way" → Shopify order refunds list for matching amount.
- `verify_return_label_sent` — "You'll receive a return label" → [[../tables/returns]] with `label_url` populated + email_events for delivery.

## Composed probes

- `check_loyalty_state` — points balance, unused vs applied coupons (verified via Shopify `asyncUsageCount` — our `status` column is stale). Used by other recipes.

## Conventions

- **Recipes return `findings` even when there are no gaps.** Audit context — useful to know we did look and it was clean.
- **`proposed_heal.action_type` MUST be a known direct action.** No new action types invented inside recipes; add to [[../libraries/action-executor]] first.
- **Never call recipes in tight loops.** API rate limits are real. Recipes must aggressively cache probes within a single run.
- **Heal customer messages include the OUTCOME, not the gap.** Don't say "we noticed we hadn't applied your coupon" — say "your $15 coupon is now on order X, deducted at next renewal."

## Files touched

| File | Purpose |
|---|---|
| `src/lib/research/index.ts` | Recipe registry + `runRecipe()` |
| `src/lib/research/recipes/*.ts` | Individual recipes (one file each) |
| `src/lib/research/probes/*.ts` | Shared deterministic probes |
| `src/lib/research/types.ts` | TS types for `ResearchRecipe` + `ResearchResult` |
| `src/lib/inngest/ticket-research.ts` | `ticket/research.requested` Inngest function |
| `src/lib/inngest/ticket-heal.ts` | `ticket/heal.requested` Inngest function |
| `src/app/api/workspaces/[id]/tickets/[tid]/heal/route.ts` | Manual heal-button endpoint |
| `src/app/dashboard/tickets/[id]/ResearchPanel.tsx` | Ticket detail surface |
| `src/lib/action-executor.ts` | Heal action dispatch |

## Status / open work

**Shipped:** Phase 1 (manual heal) — three recipes (`verify_subscription_changes`, `verify_coupon_promises`, `verify_grandfathered_pricing`). Manual heal endpoint at `/api/workspaces/[id]/tickets/[ticketId]/heal/route.ts`. Ticket-detail UI integration.

**Known gaps / not yet shipped:**
- **Phase 2 (auto-heal via allowlist) — NOT shipped.** Documentation describes auto-triggered heals against an allowlist, but no auto-execution path is wired. Manual heal only today.
- **Planned recipes — NOT shipped:** `verify_replacement_promises`, `verify_refund_issued`, `verify_return_label_sent`. Only the three Phase 1 recipes exist in `RECIPE_REGISTRY` (`src/lib/research/index.ts`).

**Recent activity:**
- `02c6acf2` Research & Heal: verify_grandfathered_pricing recipe (proactive)
- `4a0c1d3f` Research & Heal: verify_subscription_changes recipe + orchestrator retry
- `caa4c59a` Research & Heal Phase 1: framework + verify_coupon_promises + ticket UI

**Open questions:**
- When does Phase 2 ship — and what's the allowlist policy (which recipes auto-execute vs require human approval)?
- Recipe coverage: which of the planned three should we build next?

## Related

[[ai-multi-turn]] · [[ticket-lifecycle]] · [[../tables/ticket_research_runs]] · [[../tables/ticket_heal_attempts]] · [[../tables/ticket_analyses]] · [[../inngest/ticket-research]] · [[../libraries/research_index]] · [[../libraries/action-executor]]
