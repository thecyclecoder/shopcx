# libraries/journey-definition-probe

`journey_definitions` activity probe — the DB probe Phase 3 of [[../specs/review-request-sol-session]] pins ("`journey_definition_active_by_slug`") so delivery works is asserted against the DATABASE, not the filesystem.

**File:** `src/lib/journey-definition-probe.ts`

## Why

The spec's Phase-3 § "Reachability, not just compilation":

> review-collection-foundations Phase 3 shipped this journey's HANDLER while its `journey_definitions` row was never created — the phase's checks were code-existence greps, all true, none of them the thing that mattered, so it read `shipped` while the journey was unreachable. This phase carries a `journey_definition_active_by_slug` DB probe so 'delivery works' is asserted against the database rather than the filesystem.

That's this probe. `assertProductReviewJourneyActive(admin, workspaceId)` is called BEFORE any review-request send — a null / inactive row is a hard SKIP, so a workspace whose seed silently missed doesn't burn goodwill on a link that resolves to a 404.

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `PRODUCT_REVIEW_JOURNEY_SLUG` | const | `'product-review'` — the exact slug the seed migration writes. |
| `JourneyDefinitionProbeResult` | type | Discriminated union: `{ active: true, journeyId }` \| `{ active: false, reason: 'not_found' \| 'inactive' }`. |
| `assertJourneyDefinitionActive(admin, workspaceId, slug)` | async function | Slug-based probe. Kept exported so a future journey can reuse it. |
| `assertProductReviewJourneyActive(admin, workspaceId)` | async function | Domain shortcut for the product-review journey — the pinned slug is never fat-fingered at a call site. |

## Design

Small `.from("journey_definitions").select("id, is_active").eq("workspace_id", …).eq("slug", …).maybeSingle()`. Distinguishes missing (`not_found`) from inactive (`inactive`) so the caller can log the specific reason (both are hard SKIPs, but the log line differs). Empty inputs short-circuit BEFORE the DB read (defensive — a callsite that reaches here with an empty workspaceId is a bug, but "return not_found" lets the caller continue rather than throw).

## Callers

- **Phase-3 send path** — called before any drafted review-request message is queued to the outbox. A non-active journey ⇒ skip.
- **The [[review-request-nudge-cron]]** — the nudge's URL points at the SAME journey; if the seed silently missed on some workspace we don't want to send a link that 404s.
- **A future health probe** — a Control Tower tile could periodically walk this to prove every workspace's product-review journey is still live.

## Related

- **Seed migration** — `supabase/migrations/20261215130000_seed_product_review_journey.sql` writes the row this probe reads.
- **Handler** — `src/lib/portal/handlers/review-journey.ts` renders the journey.
- **Journey table** — [[../tables/journey_sessions]] · [[../tables/journey_definitions]].

---

[[../README]] · [[../../CLAUDE]]
