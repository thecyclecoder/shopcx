# product_reviews

Klaviyo-synced product reviews with AI summaries. Used for cancel-journey social proof.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `shopify_product_id` | `text` | — |  |
| `reviewer_name` | `text` | ✓ |  |
| `rating` | `int4` | ✓ |  |
| `title` | `text` | ✓ |  |
| `body` | `text` | ✓ |  |
| `summary` | `text` | ✓ |  |
| `verified_purchase` | `bool` | ✓ | default: `false` |
| `featured` | `bool` | ✓ | default: `false` |
| `klaviyo_review_id` | `text` | ✓ |  |
| `published_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `review_type` | `text` | — | default: `'review'` |
| `status` | `text` | — | default: `'published'` |
| `email` | `text` | ✓ |  |
| `smart_quote` | `text` | ✓ |  |
| `images` | `text[]` | ✓ | default: `'{}'` |
| `product_name` | `text` | ✓ |  |
| `updated_at` | `timestamptz` | ✓ |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `cancel_relevance` | `jsonb` | ✓ |  |
| `cancel_relevance_at` | `timestamptz` | ✓ |  |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `body_locked_at` | `timestamptz` | ✓ |  |
| `body_polished_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_reviews")
  .select("id, title, created_at, status, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("product_reviews")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("product_reviews")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("product_reviews")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Synced from Klaviyo. AI-summarized (Haiku, max 15 words) for cancel-journey social proof.
- Featured reviews (`smart_featured` from Klaviyo) prioritized, then highest-rated.

## Ad tool

- **Tier-4 PROOF-ONLY ad source** for [[product_ad_angles]]. Qualifying rows: `rating>=4`. Reviews can be **cited** as a proof anchor (`proof_anchor.type='review'`) but must **never lead** an angle — the lead is always a Tier-1/Tier-2 verbatim benefit.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
