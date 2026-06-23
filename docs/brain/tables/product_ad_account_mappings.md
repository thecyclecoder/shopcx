# product_ad_account_mappings

The persistent linked-group → Meta ad-account(s) map behind **AcqROAS**
([[../specs/growth-acquisition-roas-spine]] Phase 3). Removes the old `coffee → 'd6d619a5'` hardcode and
carries, per mapping, the **spend split** and the **versioned attribution assumptions** the metric
surfaces on its report. Read by [[../libraries/acquisition-roas]] (`getProductAdAccountMapping` /
`computeAcqROAS`).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `group_id` | `uuid` | — | → [[product_link_groups]].id — the linked-product line (e.g. coffee = Amazing Coffee + K-Cups) |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id (UUID, internal join — never `meta_account_id`) |
| `spend_share` | `numeric` | — | default: `1.0` · `CHECK (0 < share ≤ 1)` — fraction of the account's Meta spend charged to this group |
| `is_shared_account` | `bool` | — | default: `false` — account serves >1 line; with share 1.0 → AcqROAS is a conservative floor |
| `credit_amazon_to_meta` | `bool` | — | default: `true` — include the Amazon halo in the numerator (assumption a) |
| `count_all_non_renewal` | `bool` | — | default: `true` — count every non-renewal on-site sale, not just `utm_source=meta` (assumption b) |
| `notes` | `text` | ✓ | plain-text "why" for this mapping / share choice |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`
- `group_id` → [[product_link_groups]].`id`
- `meta_ad_account_id` → [[meta_ad_accounts]].`id`

**In (others → this):** _None._

## Indexes

- `product_ad_account_mappings_group_account_uniq` — UNIQUE `(group_id, meta_ad_account_id)` (one row per pair; upsert target)
- `product_ad_account_mappings_workspace_idx` — `(workspace_id)`
- `product_ad_account_mappings_account_idx` — `(meta_ad_account_id)`

## Common queries

### Mapping for a group (joined to the ad-account identity)
```ts
const { data } = await admin.from("product_ad_account_mappings")
  .select("id, spend_share, is_shared_account, credit_amazon_to_meta, count_all_non_renewal, meta_ad_accounts(meta_account_id, meta_account_name)")
  .eq("workspace_id", workspaceId)
  .eq("group_id", groupId);
```

## Gotchas

- **The shared-account split is a judgment call per account.** The 'Amazing Coffee & Creamer' account
  serves BOTH coffee and creamer. Until a real split is known, seed `is_shared_account=true,
  spend_share=1.0` → the metric charges all its spend to coffee and flags itself a **conservative floor**
  (the spec's 1.69 baseline). Set `spend_share < 1.0` only once a defensible split exists; Σ of an
  account's shares across its groups should be ≤ 1.
- **Assumptions are read per group, expected uniform across its rows.** `computeAcqROAS` ANDs
  `credit_amazon_to_meta` / `count_all_non_renewal` across a group's mapping rows — keep them consistent.
- RLS: any authenticated user reads; service role writes (mirrors [[director_activity]]).
- Seeded by `scripts/seed-coffee-ad-account-mapping.ts`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
