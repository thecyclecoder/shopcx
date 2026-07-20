# returns

Customer returns. status: open → label_created → in_transit → delivered → refunded. See returns pipeline in CLAUDE.md.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `order_id` | `uuid` | ✓ | → [[orders]].id |
| `order_number` | `text` | — |  |
| `shopify_order_gid` | `text` | ✓ | `null` for an **internal-order** return (SHOPCX*, no Shopify order — `20260628120000`). A Shopify return populates it. |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `shopify_return_gid` | `text` | ✓ |  |
| `shopify_reverse_fulfillment_order_gid` | `text` | ✓ |  |
| `shopify_reverse_delivery_gid` | `text` | ✓ |  |
| `status` | `text` | — | default: `'pending'` |
| `resolution_type` | `text` | — |  |
| `source` | `text` | — | default: `'playbook'` |
| `order_total_cents` | `int4` | — | default: `0` |
| `label_cost_cents` | `int4` | — | default: `0` |
| `net_refund_cents` | `int4` | — | default: `0` |
| `refund_shortfall_cents` | `int4` | ✓ | Audit delta when the live gateway ceiling capped the refund below `net_refund_cents`. Null == not capped (common). Set by `returnsIssueRefund` reconcile. |
| `refund_id` | `text` | ✓ | Sentinel `'out_of_band_shopify'` when the money already moved outside ShopCX (Phase 1 stamp — no refund fired). |
| `tracking_number` | `text` | ✓ |  |
| `carrier` | `text` | ✓ |  |
| `label_url` | `text` | ✓ |  |
| `easypost_shipment_id` | `text` | ✓ |  |
| `return_line_items` | `jsonb` | — | default: `'[]'` |
| `shipped_at` | `timestamptz` | ✓ |  |
| `delivered_at` | `timestamptz` | ✓ |  |
| `processed_at` | `timestamptz` | ✓ |  |
| `refunded_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `order_id` → [[orders]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### Customer's open + non-cancelled returns
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("returns")
  .select("order_number, status, label_url, tracking_number, net_refund_cents, delivered_at, refunded_at")
  .in("customer_id", ids)
  .neq("status", "cancelled")
  .order("created_at", { ascending: false });
```

### Returns we created (filter out imported/external)
```ts
const { data } = await admin.from("returns")
  .select("*")
  .eq("workspace_id", workspaceId)
  .not("easypost_shipment_id", "is", null);
```

### Returns awaiting refund (delivered but no refund yet)
```ts
const { data } = await admin.from("returns")
  .select("id, order_number, net_refund_cents, delivered_at")
  .eq("workspace_id", workspaceId)
  .eq("status", "delivered")
  .is("refunded_at", null);
```

### Failed-refund returns needing manual action
```ts
const { data } = await admin.from("dashboard_notifications")
  .select("title, body, ticket_id")
  .eq("workspace_id", workspaceId)
  .eq("type", "manual_action_needed")
  .ilike("title", "%Return%");
```

## Gotchas

- `status`: production values (as of probe): `"closed"`, `"label_created"`, `"refunded"`, `"open"`, `"cancelled"`, `"in_transit"`, `"delivered"`. The earlier spec referenced `"restocked"` — not seen in data. Treat `"closed"` as a final state distinct from `"refunded"` (e.g. customer-paid-shipping returns that hit a refund-failure branch and were manually closed).
- `resolution_type`: `"refund_return"`, `"store_credit_return"`, `"refund_no_return"`, `"store_credit_no_return"`.
- `source`: `"ai"`, `"agent"`, `"playbook"`, `"portal"`, `"system"`.
- There is no `name` column — use `order_number`.
- Returns refund on EasyPost `delivered`, **not** carrier first-scan. See feedback_return_refund_trigger.
- Filter to returns we created: `.not("easypost_shipment_id", "is", null)`. Imported/external returns we don't own the refund for.
- `net_refund_cents` is the **contract** — set at return-creation and never re-derived at refund time; the pipeline never RAISES it. The live gateway ledger (read by `getOrderRefundLedger` in `src/lib/refund-ledger.ts`) is the **ceiling**: `returnsIssueRefund` reconciles before dispatch and CAPS the payout to what the gateway will still allow (SC133086 / SC129432), stamping the return as already-settled when the money already moved out-of-band (SC130193) and repairing a null `order_id` from `shopify_order_gid` (SC131156). Contract == intent, ledger == ceiling.
- `refund_shortfall_cents` records the audit delta on the CAP branch (contract minus what the ledger allowed to refund). Null on the common path.
- `refund_id = 'out_of_band_shopify'` is the Phase-1 out-of-band sentinel — the return was stamped `refunded` without moving money because the gateway already showed the customer paid back outside ShopCX.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
