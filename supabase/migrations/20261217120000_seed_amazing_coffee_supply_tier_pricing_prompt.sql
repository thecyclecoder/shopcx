-- Sonnet prompt rule: Amazing Coffee — reconcile storefront supply-tier
-- (quantity) pricing with the FLAT subscription unit price, plus the
-- 8-week (every-2-months) maximum billing interval. Derived from ticket
-- b28e7744-0451-46eb-a675-33836b96e491 (Juana Webman, $2233 LTV): the
-- AI first denied tiered pricing existed and fabricated her account
-- history, then over-corrected by confirming a storefront supply-tier
-- price ($158.30 for 3 bags every 90 days) as a recurring subscriber
-- rate — a price the subscription surface cannot deliver (subs price
-- Amazing Coffee FLAT at $59.96/bag; 3 bags = $179.88) at an interval
-- (90 days) the platform does not offer (8 weeks is the cap). The rule
-- gives the orchestrator durable ground truth so it neither denies the
-- storefront tiers nor promises them as recurring, and forces the
-- supply-size-vs-delivery-interval framing on any "bulk price at 90
-- days" ask.
--
-- Tenant-boundary scope (Phase 2 spec-test regression fix — pre-merge
-- security check flagged the original `SELECT w.id FROM workspaces w`
-- fan-out as an authz/tenant-boundary regression: the prompt content
-- itself is merchant-specific and workspace-scoped reads make it
-- visible/active as another workspace's own rule). This migration now
-- scopes the INSERT to ONLY the workspace that owns the source ticket
-- — a CTE resolves `owner (workspace_id, ticket_id)` from
-- `public.tickets` where `id = b28e7744-…`. When the ticket is absent
-- (fresh env / other database), the CTE returns zero rows and the
-- INSERT is a no-op — idempotent + safe. The `NOT EXISTS` guard
-- likewise re-scopes to that workspace so a re-run doesn't duplicate.

WITH owner AS (
  SELECT t.workspace_id, t.id AS ticket_id
  FROM public.tickets t
  WHERE t.id = 'b28e7744-0451-46eb-a675-33836b96e491'::uuid
  LIMIT 1
)
INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order, derived_from_ticket_id)
SELECT
  owner.workspace_id,
  'rule',
  'Amazing Coffee — storefront supply tiers vs flat subscription pricing (+ 8-week interval cap)',
  $$Amazing Coffee is sold two DIFFERENT ways with DIFFERENT pricing surfaces. Do not conflate them.

STOREFRONT / ONE-TIME PURCHASE (quantity-supply tiers): the public product page offers 30-day (1 bag, 25% off), 60-day (2 bags, 31% off), and 90-day (3 bags, 34% off) supply tiers. These are ONE-TIME purchases whose bulk discount scales with the QUANTITY OF BAGS ordered in that single transaction. The "30/60/90-day" label describes how long that many bags is expected to last a typical drinker — NOT the delivery cadence on a recurring plan.

SUBSCRIPTION (the recurring surface): our subscription platform prices Amazing Coffee FLAT at the standard 25% off per bag (currently $59.96/bag). Quantity does not compound the discount on a subscription — 3 bags recurring is 3 × $59.96 = $179.88, NOT the storefront's $158.30 three-bag price. Any deeper per-bag discount on a subscription is applied ONLY when a specific coupon exists on that subscription (e.g. a "Buy 2 Discount PERCENTAGE 8" code), and the Buy-3 equivalent, if any, has to be VERIFIED before quoting — never assume the storefront tier percentages carry over to renewals.

INTERVAL CAP: the maximum billing interval we offer is 8 weeks / every 2 months. 90 days / 3 months / quarterly is NOT a selectable interval — do not promise it. The customer-facing frequency labels are 2wk="Twice a Month", 4wk="Monthly", 8wk="Every 2 Months".

SUPPLY SIZE vs DELIVERY INTERVAL — the framing to use with the customer: how many bags per shipment ("supply size") is one lever; how often that shipment arrives ("delivery interval") is a separate lever. Storefront bulk discounts key off supply size in a single order; subscription cadence is capped at 8 weeks regardless of supply size. A "3 bags every 90 days" ask is impossible AS STATED — it fuses a one-time bulk-order price shape with a cadence we don't offer. Resolve it honestly: (a) confirm the recurring per-bag price the subscription can actually deliver (flat $59.96 unless a verified coupon says otherwise); (b) offer 3 bags at the 8-week interval (fastest allowed cadence for that supply size) if that matches consumption; (c) if 3 bags every 8 weeks over-supplies them, suggest a smaller supply size at the interval that matches their consumption; (d) if they still want the storefront bulk price specifically, name it as a ONE-TIME purchase — the sub surface cannot recur at that price.

RULES:
- NEVER quote a storefront supply-tier price ($158.30 / $148.72 / etc.) as a recurring subscription price without checking the sub's actual pricing (`get_customer_account` renders per-line `realized` prices).
- NEVER offer a 90-day / quarterly / 12-week / monthly-in-months cadence — 8 weeks is the maximum.
- NEVER deny that tiered supply pricing exists on the storefront — it does; it is just not how the subscription surface prices.
- If a returning customer asks to reactivate at "the bulk price", ask which they mean: the storefront one-time bulk price (do a one-time order) or a recurring subscription (quote the actual flat sub price + any coupon actually on the sub).
$$,
  25,
  owner.ticket_id
FROM owner
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = owner.workspace_id
    AND sp.title = 'Amazing Coffee — storefront supply tiers vs flat subscription pricing (+ 8-week interval cap)'
);
