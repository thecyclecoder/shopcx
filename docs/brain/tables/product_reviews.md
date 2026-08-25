# product_reviews

Product reviews with AI summaries. Storefront PDPs, ad-tool proof anchors, product intelligence, cancel-journey social proof, review cards, storefront email.

⚠️ **No longer synced — and nothing collects reviews today.** The Klaviyo sync upsert was the ONLY INSERT into this table anywhere in the codebase, and Klaviyo is retired ([[../integrations/klaviyo]]). The newest row is **2026-07-01**. The table itself is permanent and heavily read; it is the *write* side that needs the in-house reviews program.

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
| `rejection_reason` | `text` | ✓ | Why a moderator rejected it. NULL for pre-sunset rejections (that reason lived only in Klaviyo) |
| `rejection_explanation` | `text` | ✓ | Free-text the moderator typed alongside the reason |
| `moderated_at` | `timestamptz` | ✓ | Last human moderation action on the row |

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

- **Moderation is local-only** since the Klaviyo sunset. `/api/workspaces/[id]/reviews/[reviewId]` PATCH used to round-trip every publish/reject/feature to Klaviyo for any row with a `klaviyo_review_id` — all 10,745 of them — which would have hard-500'd the moment the key stopped authenticating. This table is now the sole system of record for moderation state. See [[../dashboard/reviews]].
- `klaviyo_review_id` is **provenance only** now. Don't branch on it.
- Historically imported from Klaviyo and AI-summarized (Haiku, max 15 words) for cancel-journey social proof. Featured reviews (`smart_featured` from Klaviyo) prioritized, then highest-rated — `featured` / `status='featured'` still drive that ordering, they're just set by hand now.
- **`images` are Klaviyo-relative paths** (`{company_id}/{uuid}.jpg?updated_at=…`), not URLs — 95 rows. Nothing renders them; the assets live on Klaviyo's CDN and die with the account. `scripts/_backfill-review-images-to-storage.ts` mirrors them once the CDN base is supplied.
- Status enum in use: `published` (9,344) · `rejected` (1,327) · `featured` (74). `pending` / `unpublished` are counted by the dashboard API but no rows carry them.

## Ad tool

- **Tier-4 PROOF-ONLY ad source** for [[product_ad_angles]]. Qualifying rows: `rating>=4`. Reviews can be **cited** as a proof anchor (`proof_anchor.type='review'`) but must **never lead** an angle — the lead is always a Tier-1/Tier-2 verbatim benefit.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
