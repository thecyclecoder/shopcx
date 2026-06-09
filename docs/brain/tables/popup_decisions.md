# popup_decisions

One row per smart-popup decision per session (storefront-mvp Phase 4). Logs the variant + reason + which decider produced it (rules vs Haiku) + the outcome funnel (shown → engaged → converted), from day one — so "smart" can be proven against a dumb timer and the Haiku prompt tuned.

**Primary key:** `id` · **Unique:** `(workspace_id, anonymous_id)` — one decision per session.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | → [[workspaces]] |
| `anonymous_id` | `text` | the `sid` cookie — session binding |
| `session_id` | `uuid` | → [[storefront_sessions]] (nullable) |
| `customer_id` | `uuid` | → [[customers]] (nullable, set once identified) |
| `variant` | `text` | `discount` \| `quiz` \| `none` (none = candidacy passed, decider suppressed — measures suppression too) |
| `reason` | `text` | snake_case trigger (`cta_to_price_no_select`, `price_dwell_no_select`, `rage_taps_in_price`, `bot`, …) |
| `decided_by` | `text` | `rules` \| `haiku` (the A/B arm) |
| `offer` | `jsonb` | snapshot of the computed stacked offer ([[../libraries/popup-offer]]) |
| `shown` / `engaged` / `converted` | `bool` | outcome funnel, patched via `/api/popup/outcome` + `/api/popup/claim` |
| `coupon_code` | `text` | the minted code, set on conversion |

## Who writes it

- `/api/popup/decide` — inserts the single per-session row (seeds `shown`).
- `/api/popup/outcome` — flips `engaged` (popup interacted) on the way to convert.
- `/api/popup/claim` — flips `engaged` + `converted` + stamps `coupon_code` when the phone step verifies.

## Analytics use

`decided_by` × `converted` proves rules-vs-Haiku lift; `variant` × `converted` proves discount-vs-quiz; `reason` shows which hesitation signals convert.

---

[[../README]] · [[../lifecycles/storefront-checkout]] · [[../libraries/popup-decide]] · [[../tables/storefront_leads]] · [[../../CLAUDE]]
