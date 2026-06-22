# pricing_rule_offer_events

Append-only **audit trail** for [[pricing_rule_offers]] (M6, [[../specs/storefront-dynamic-renewal-offers]]). A persist-to-renewal offer touched **real renewals**, so every lifecycle state change is logged — the offer is supervisable end-to-end (the north star).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `offer_id` | `uuid` | — | → [[pricing_rule_offers]].id (on delete cascade) |
| `event` | `text` | — | `proposed`｜`margin_blocked`｜`approved`｜`activated`｜`expired`｜`rolled_back`｜`killed`｜`bound_subscription`｜`revoked` |
| `actor` | `text` | ✓ | `storefront-optimizer` (agent) or an owner uuid — plain text (no FK to auth) |
| `reason` | `text` | ✓ | human/agent-legible reason (e.g. the margin verdict) |
| `detail` | `jsonb` | — | default `{}` — structured context (margin model, subscription_id, …) |
| `created_at` | `timestamptz` | — | default `now()` |

## Common queries

### The full lifecycle of one offer
```ts
const { data } = await admin.from("pricing_rule_offer_events")
  .select("event, actor, reason, created_at")
  .eq("offer_id", offerId)
  .order("created_at", { ascending: true });
```

## Gotchas

- Written only via `logOfferEvent` ([[../libraries/storefront-renewal-offers]]) — append-only, never updated/deleted. A logging failure is swallowed (best-effort) so it never breaks the offer write itself.

---

[[../README]] · [[pricing_rule_offers]] · [[../specs/storefront-dynamic-renewal-offers]]
