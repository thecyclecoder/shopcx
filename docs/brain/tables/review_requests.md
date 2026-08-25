# review_requests

One row per review ask. The ladder's memory — which angle a customer already
received for a product, which channel, when it was sent + nudged, and the
outcome. The review-collection program (Phase 1) creates this table; the sibling
"asking" spec is what will write rows into it.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `customer_id` | `uuid` | — | → [[customers]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | — | → [[products]].id · ON DELETE CASCADE. The product this ask is about — a review is product-specific. Never non-reviewable (the sender filters `products.reviewable = true`). |
| `journey_session_id` | `uuid` | ✓ | → [[journey_sessions]].id · ON DELETE SET NULL. Set when the customer clicks the link and a session materializes; a never-clicked ask stays NULL. |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id · ON DELETE SET NULL. Set when a 1-3 star submission routes to CS as a ticket instead of publishing. Null for the happy path (rating ≥ 4). |
| `angle` | `text` | — | Which ladder rung this ask used — e.g. `first-touch` / `nudge` / a product-specific variant. Free-text so the ladder can add angles without a migration; the fixed list lives in the journey definition. |
| `channel` | `text` | — | `email` · `sms` — text so future channels (mini-site, in-app, ...) don't need a migration. |
| `sent_at` | `timestamptz` | — | default: `now()` · when the ask went out |
| `nudged_at` | `timestamptz` | ✓ | When the ladder's one follow-up went out. Null until then. One nudge per ask maximum. |
| `outcome` | `text` | — | default: `'sent'` · lifecycle marker — `sent` → `clicked` → `submitted` \| `routed_to_cs` \| `expired`. Text so the ladder can add outcomes without a migration; readers probe actual values (CLAUDE.md § "Database is the spec"). |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` · maintained by the `review_requests_touch_updated_at` trigger |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (ON DELETE CASCADE)
- `customer_id` → [[customers]].`id` (ON DELETE CASCADE)
- `product_id` → [[products]].`id` (ON DELETE CASCADE)
- `journey_session_id` → [[journey_sessions]].`id` (ON DELETE SET NULL)
- `ticket_id` → [[tickets]].`id` (ON DELETE SET NULL)

**In (others → this):**

_None._

## Indexes

- `review_requests_customer_product_idx (workspace_id, customer_id, product_id, sent_at desc)` — the ladder's dedup read: "has this customer already been asked about this product?"
- `review_requests_outcome_idx (workspace_id, outcome, sent_at desc)` — bucket-by-outcome for the roadmap card.
- `review_requests_journey_session_idx (journey_session_id) where journey_session_id is not null` — session → ask lookup on submit.
- `review_requests_ticket_id_idx (ticket_id) where ticket_id is not null` — ticket → ask lookup when CS opens the escalated 1-3 star row.

## RLS

- `review_requests_member_read` — any authenticated workspace member can select rows for their workspaces.
- `review_requests_service_role` — service role does all writes.

## Common queries

### Has this customer already been asked about this product?
```ts
const { data } = await admin.from("review_requests")
  .select("id, angle, sent_at, outcome")
  .eq("workspace_id", workspaceId)
  .eq("customer_id", customerId)
  .eq("product_id", productId)
  .order("sent_at", { ascending: false })
  .limit(1);
```

### Bucket by outcome
```ts
const { data } = await admin.from("review_requests")
  .select("outcome").eq("workspace_id", workspaceId).limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.outcome, (counts.get(r.outcome) || 0) + 1);
```

## Gotchas

- **A row is written when the ask is SENT, not when the customer submits.** The `journey_session_id` is null until the customer clicks the tokenized link and a session materializes; the sender writes the row first so the ladder's dedup read (has this customer been asked?) works before any click.
- **`ticket_id` is set only for 1-3 star submissions.** Per the moderation rule, a low-star review is NOT published — it opens a CS ticket instead, and that ticket's id is stamped here so CS can see the originating ask.
- **`outcome` is a string, not an enum.** Readers probe actual values (CLAUDE.md § "Database is the spec"). The ladder writes `sent` at insert, then transitions to `clicked` / `submitted` / `routed_to_cs` / `expired` as it observes.
- **Never insert a row where `products.reviewable = false`.** The sender must filter on that column; skipping the check would ask a customer about Shipping Protection.
- **One nudge maximum per ask.** `nudged_at` is a single timestamp, not an array — a second nudge would be a design change, not a data change.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../specs/review-collection-foundations]]
