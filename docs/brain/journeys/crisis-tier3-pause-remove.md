# Crisis Tier 3 — Pause/Remove

Last-ditch retention. Fires `tier_wait_days` after a Tier 2 rejection. Behavior diverges by segment.

DB row in [[../tables/journey_definitions]]: `slug='crisis-tier3-pause-remove'`, `journey_type='custom'`, `trigger_intent='crisis_tier3'`.

See [[../lifecycles/crisis-campaign]].

## Trigger

- **trigger_intent**: `crisis_tier3` (system, not customer-initiated)
- **match_patterns**: empty
- **priority**: 10

## Channel

`email` only.

## Segment branch

[[../tables/crisis_customer_actions]].`segment` decides the wording + actions:

- **`berry_only`** — the affected variant is the ONLY real item in the sub.
- **`berry_plus`** — there are other items beyond the affected one.

Shipping protection doesn't count as a "real item" — a sub of "Mixed Berry + Shipping Protection" is `berry_only`.

## Steps — berry_only

> "We'll pause your subscription and automatically restart it when [variant] is back in stock."

1. **Choice**: "Pause until it's back" / "I'd rather cancel."

On pause:

- [[../integrations/appstle]] `appstleSubscriptionAction("pause")`.
- Update [[../tables/crisis_customer_actions]]: `paused_at=now()`, `auto_resume=true`. The pause is NOT auto-scheduled — it stays paused until crisis resolution.
- `tier3_response='accepted_pause'`.

On cancel:

- Launch [[cancel]] journey.
- `tier3_response='rejected'`.

## Steps — berry_plus

> "We'll remove [variant] from your subscription and keep shipping your other items. We'll add it back when it's in stock."

1. **Choice**: "Remove it for now" / "I'd rather cancel the whole subscription."

On remove:

- [[../integrations/appstle]] subscription line-item remove for the affected variant.
- Sub keeps billing normally for the remaining items.
- Update [[../tables/crisis_customer_actions]]: `removed_item_at=now()`, `auto_readd=true`.
- `tier3_response='accepted_remove'`.

On cancel:

- Launch [[cancel]] journey.
- `tier3_response='rejected'`.

## Resolution

When admin clicks "Resolve Crisis" at `/dashboard/crisis/{id}`:

- For rows where `auto_resume=true` → [[../integrations/appstle]] `resume()` + email "Your subscription is restarted."
- For rows where `auto_readd=true` → line-item add the original variant back + email "[variant] is back."

## Outcomes

Tracked on [[../tables/crisis_customer_actions]].`tier3_response` (`accepted_pause` / `accepted_remove` / `rejected`).

For rejection-into-cancel, the cancel journey's own outcome tags (`jo:positive` / `jo:negative`) apply on the ticket.

## Step ticket status

`open`.

## Files

| File | Purpose |
|---|---|
| `src/lib/crisis-journey-builder.ts` | Tier 3 builder |
| `src/lib/inngest/crisis-campaign.ts` | Tier advancement cron |
| `src/lib/appstle.ts` | pause + line-item remove |
| `src/lib/subscription-items.ts` | Line-item remove helper |
| `src/lib/email.ts` | Tier 3 email template |
| `src/lib/journey-launcher.ts` | Cancel journey re-launch on rejection |
| `src/app/api/journey/[token]/complete/route.ts` | Execute pause or remove |
| `src/app/api/workspaces/[id]/crisis/[crisisId]/resolve/route.ts` | Mass resolve action |

## Related

[[../lifecycles/crisis-campaign]] · [[crisis-tier1-flavor-swap]] · [[crisis-tier2-product-swap]] · [[cancel]] · [[../tables/crisis_events]] · [[../tables/crisis_customer_actions]] · [[../tables/subscriptions]] · [[../integrations/appstle]] · [[../inngest/crisis-campaign]] · [[../inngest/portal-auto-resume]]
