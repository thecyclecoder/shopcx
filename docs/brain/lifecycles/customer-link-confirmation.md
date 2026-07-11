# Customer link confirmation

Customers exist as multiple records — `dylan@superfoodscompany.com`, `+1 858 334 9198`, the IG handle `@dralston`, the Meta DM sender id `12345`. Linking them into a single graph is foundational for retention, fraud detection, support context, and analytics. This page traces the full linking lifecycle: automatic match → agent / customer confirmation → backfill → ongoing maintenance.

## Cast

- Graph: [[../tables/customer_links]] (group_id-based grouping).
- Rejections: [[../tables/customer_link_rejections]].
- Meta-specific bridge: [[../tables/meta_sender_customer_links]].
- Auto-link triggers: `src/lib/account-matching.ts`, `src/lib/auto-link-customer-from-message.ts`.
- Inline confirmation: `src/lib/account-linking-journey-builder.ts`.
- Backfill triggers: identity-stitch helpers + [[../inngest/refresh-customer-segments]].

## Why links

A linked group of [[../tables/customers]] sharing a `group_id`:

- Combines [[../tables/orders]], [[../tables/subscriptions]], [[../tables/tickets]], [[../tables/returns]], [[../tables/customer_events]] across all profile ids in the group.
- Drives accurate LTV and retention scoring.
- Lets the AI orchestrator see "they bought this on the other email" without manual context-building.
- Makes fraud detection aggregate across all profiles (shared addresses, velocity).
- Marketing decisions key off the **main** customer in the group — see feedback in [[../journeys/README]].

## Sources of evidence

Several signals propose a link:

1. **Same email** — trivial (same row).
2. **Same phone** — different email but same phone → propose link.
3. **Same default address** — bill+ship both match → propose link.
4. **Shopify customer merge** — fires `customers/merge` webhook; auto-link.
5. **Meta sender** — DM lands; we ask "is this you?" if email match exists.
6. **Order-number search** — customer messages with an order # belonging to a different email → auto-link to the order's owner (Phase 2; resolves via Shopify when the order isn't synced locally).

Each surface generates a *candidate* link; we always seek confirmation before committing high-impact actions on the back of it.

## Phase 1 — Shopify-side auto-merge

The most authoritative signal. Shopify's `customers/merge` webhook fires when a Shopify staff member or the customer themselves merges two customer profiles (usually a Shop login linking a guest order). Handler in `src/lib/shopify-webhooks.ts`:

1. Identify the surviving Shopify customer + the merged-into-it id.
2. Look up our internal UUIDs in [[../tables/customers]] for both.
3. Link via [[../tables/customer_links]] with shared `group_id`. Pick the existing group_id if either side already has one; mint a new one otherwise.
4. Re-attribute all rows referencing either customer_id — orders, subs, tickets, returns — stay where they are; we only need the link, not the FK rewrite.

No customer confirmation needed — Shopify already authoritative.

## Phase 2 — message-driven auto-link

Before Sonnet runs, `src/lib/auto-link-customer-from-message.ts` scans the **last 10 inbound external messages** on the ticket (not just the latest — the identifier is often given a turn or two before we act on it) and links any identifier that resolves to a *different* customer profile in the same workspace. Wired as the `auto-link-from-inbound` step in [[../inngest/unified-ticket-handler]], on every customer inbound. Best-effort, never throws; the orchestrator runs regardless. Links commit **silently** — an explicit mention IS the confirmation (this is the auto-confirm path; the inline confirm in Phase 3 is for *candidate* links surfaced elsewhere, e.g. name-match journeys).

Two identifier kinds:

1. **Email** — extract addresses (our own + transactional domains filtered out), look up [[../tables/customers]] by email, link if found and not already in the same group.
2. **Order number** — extract `SC######`-style names + bare numerics in an explicit "order #…" context, then resolve the order's **owner**:
   - our [[../tables/orders]] by `order_number` (the Shopify order *name*, e.g. `SC132076`; the table has no `name` column — see [[../tables/orders]]), else
   - **Shopify fallback** for unsynced orders: `orders(first:1, query:"name:…")` → read the order's email + customer; find the local profile by `shopify_customer_id`, then by email; if none exists, **create a minimal customer row** (upsert on `workspace_id,shopify_customer_id`, enriched by a later full sync) so there's a UUID to link.

   Then link that owner to the ticket customer. The order number is authoritative when the customer misremembers which email they ordered under — ticket 23fe617c: wrote in from `lovethosebuysllc@gmail.com`, *guessed* `lovethosebuys@gmail.com` (no profile → `link_account_by_email` hard-failed and escalated), but order **#SC132076** actually belonged to `kzcosmetiks@gmail.com`. Only the order number resolved it.

Linking before Sonnet runs lets `get_customer_account` return the merged set so the orchestrator routes straight to the right journey instead of asking an identity question the customer already answered. (Phone-number extraction is not implemented — emails + order numbers only.)

### Meta DM specifics (channel = meta_dm)

Meta delivers only a **page-scoped sender ID (PSID)** in the webhook — no email, no name, no order number. Customer resolution on inbound DMs follows a strict policy:

1. **[[../tables/meta_sender_customer_links]] lookup** — if a confirmed binding exists for the PSID, use that `customer_id`. This is the only auto-link path for DMs.
2. **Graph API name fetch** — using the recipient page's token from [[../tables/meta_pages]] (PSIDs are page-scoped; only the page that received the DM can resolve them). The returned first/last name is used for the ticket subject and the first-turn greeting; **it is NOT used to match a customer record**. Fuzzy name matching is unsafe for DMs because common names collide (multiple "Susan Smiths" in the customers table; picking one wrong is worse than admitting we don't know).
3. **If no link** → the orchestrator asks for **email or order number** on the first reply. Account-related answers ("do I have a sub?", "where's my order?", LTV, loyalty, cancel) are gated until the customer provides one. General questions (product info, return policy, ingredients) can still be answered without a match. See sonnet_prompts rule `0d75ac46-4338-47f2-aba6-8235910f98e2` for the exact greeting template.
4. **Customer's next message with email/order#** flows through Phase 2 above: `auto-link-customer-from-message.ts` extracts the identifier, resolves the customer record (Shopify fallback for order numbers), links it, and the orchestrator then runs with the matched `customer_id`.

Why: telling someone "you don't have a subscription" when they actually have a $3K LTV sub is a worse failure than a one-turn delay to verify identity. Verify-then-act is the right UX whenever the platform doesn't hand us a verified email.

App-permission context: the Meta app is in review for upgraded webhook permissions that may eventually expose customer email. Even if approved, the email/order# verification rule stays — Meta delivery of email is best-effort and won't be reliable for all senders. The DM verification flow is the permanent identification path; upgraded permissions would only reduce its frequency.

## Phase 3 — inline confirmation

When auto-confirm isn't safe, the unified handler inserts a clarifying step into the conversation:

> "I see this order belongs to **dylan@superfoodscompany.com**. Is this also you?" — yes/no buttons.

State is held on `tickets.playbook_context.awaiting_email_confirm = true` + `alternate_email` + `alternate_customer_id` + `original_message`.

If "yes":

1. `randomUUID()` generates a new `group_id` (or reuses if either already linked).
2. Upsert two [[../tables/customer_links]] rows with the same `group_id` — one for each customer.
3. Mark the alternate as `is_primary=true` (typically the email-owning side — see feedback in [[../journeys/README]] "Main account only for marketing decisions").
4. Add `[System] Accounts linked: …` internal note to the ticket.
5. Clear `playbook_context.awaiting_email_confirm`.
6. **Re-trigger** `ticket/inbound-message` with the original message body so Sonnet now has full linked context.
7. Tag the ticket `link`.

If "no":

1. Insert [[../tables/customer_link_rejections]] row with both customer ids — we never re-offer this specific link.
2. Continue handling the original message without the link.

## Phase 4 — Meta sender linking

Meta DMs are a special case because the `meta_sender_id` is opaque — no email, no phone in the inbound payload. Two-step:

1. Inbound DM arrives. `meta_sender_id` is captured but unmatched.
2. The orchestrator asks (via DM) "What email address did you use when ordering?"
3. Customer replies with email. Match to [[../tables/customers]].
4. Insert [[../tables/meta_sender_customer_links]] mapping `meta_sender_id` → `customer_id`.
5. Future DMs from this sender resolve immediately.

If the customer never gives the email, the conversation continues as anonymous — no linked history surfaced, no account actions possible.

## Phase 5 — Account-linking journey (prepend mode)

The account-linking journey is **never standalone** — it's silently prepended as the first step(s) of another journey. From [[../journeys/README]]:

> Account linking is a prepend, not an independent journey — silently inserted as the first step(s) of another journey. The CTA email doesn't mention it; it focuses on the main journey (e.g., "Claim my coupon"). Match patterns on account_linking are empty `[]` so it never fires solo.

When the discount-signup journey or cancel journey detects unlinked candidate emails for this customer (via name match), it prepends an account-linking step:

> "We found these other emails that might be yours — check the ones that are."

Customer ticks checkboxes; submit creates [[../tables/customer_links]] rows for the confirmed ones, [[../tables/customer_link_rejections]] for the unchecked.

Builder: `src/lib/account-linking-journey-builder.ts`.

## Phase 6 — backfill propagation

After a link confirms, multiple downstream systems backfill:

- **Identity-stitch for storefront events** ([[../tables/storefront_events]], [[../tables/storefront_sessions]]) — when a customer identifies, all events + sessions for the same `anonymous_id` get the customer_id. See [[storefront-checkout]].
- **Device-fingerprint backfill** — for cross-device customers. A ground-truth event (purchase, portal login) anchors a fingerprint → customer pairing and retroactively attributes 90d of prior events. See PERPETUAL-CAMPAIGNS-SPEC.md § Identity bootstrap.
- **Segment refresh** ([[../inngest/refresh-customer-segments]]) — recompute [[../tables/customers]].`segments` for the entire group.
- **Profile event aggregation** ([[../tables/profile_engagement_summary]] — currently stalled, see Klaviyo gotchas) — when populated, treats the group as one unit.

## Maintenance — what NOT to link

[[../tables/customer_link_rejections]] is the don't-re-offer list. Always check it before proposing.

Other never-link rules:

- **Shared address alone is not enough.** Families share addresses. Require email or phone match too.
- **Different first names + different last names** under the same address → likely roommates / family.
- **Banned customers do not auto-link to active customers.** [[../tables/customers]].`banned=true` rows are kept separate to avoid contaminating the active customer's reputation.

## Marketing consent on a linked group

Hard rule: marketing decisions key off the **main** customer, not the full group. Email subscribes the main customer's email; phone subscribes the main customer's phone. Linked accounts' marketing status doesn't factor into consent / email / phone steps.

See feedback "Main account only for marketing decisions" in [[../journeys/README]].

## Files touched

| File | Purpose |
|---|---|
| `src/lib/customer-links.ts` (if it exists, else inline in shopify-webhooks) | Link CRUD helpers |
| `src/lib/account-matching.ts` | Fuzzy match heuristics; address-aware confidence grading ([[../libraries/account-matching]]) |
| `src/lib/sol-link-proposal.ts` | Phase 2: Sol/June's first-class link proposal (write-then-execute) ([[../libraries/sol-link-proposal]]) |
| `src/lib/agents/needs-attention-route-cs-owner.ts` | Phase 3: Route parked CS-owned jobs to June before CEO ([[../libraries/needs-attention-route-cs-owner]]) |
| `src/lib/auto-link-customer-from-message.ts` | Message-driven linker |
| `src/lib/account-linking-journey-builder.ts` | Prepend-step builder |
| `src/lib/identity-stitch.ts` | Storefront event backfill |
| `src/lib/shopify-webhooks.ts` | customers/merge handler |
| `src/lib/inngest/unified-ticket-handler.ts` | Inline confirmation routing |
| `src/lib/social-comment-customer-match.ts` | Meta sender ↔ customer match |
| `src/lib/inngest/refresh-customer-segments.ts` | Post-link segment recompute |
| `src/app/api/journey/[token]/complete/route.ts` | Account-linking step completion |
| `src/app/dashboard/tickets/[id]/page.tsx` | Sidebar customer-match UI + manual link |

## Status / open work

**Shipped:** Shopify auto-merge webhook handling, message-driven auto-link, inline confirmation journey, Meta sender → customer linking (manual confirm via social-comments sidebar), account-linking journey prepend mode, segment refresh — all functional.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[ai-multi-turn]] · [[social-comment-moderation]] · [[storefront-checkout]] · [[../integrations/meta-graph]] · [[../integrations/shopify]] · [[../libraries/account-matching]] · [[../libraries/sol-link-proposal]] · [[../libraries/needs-attention-route-cs-owner]] · [[../tables/customer_links]] · [[../tables/customer_link_rejections]] · [[../tables/meta_sender_customer_links]] · [[../tables/customers]] · [[../inngest/refresh-customer-segments]] · [[../journeys/account-linking]]
