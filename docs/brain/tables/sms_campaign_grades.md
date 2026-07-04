# `sms_campaign_grades` — one row per graded SMS campaign

One row per concluded SMS Marketing Agent campaign (a [[sms_campaigns]] record),
carrying Iris's KPI grade. The KPI is **attributed revenue-per-send**
(`rev_per_send_cents`) — the CMO-side analogue of the storefront grader
([[storefront_campaign_grades]]). The defining shape: **hypothesis quality is scored
separately from result** (a sound theme/segment/timing bet that lost still grades high;
a lucky win from a sloppy bet grades low). Migration
`20260704120000_sms_marketing_agent.sql`. RLS: authenticated SELECT, service-role
write. See [[../inngest/sms-marketing]] · [[../sms-segment-performance]] ·
[[../functions/cmo]].

> **Grader is future work.** The **table + grading surface exist now** so campaigns
> accrue gradeable state from day one, but the automated grading sweep (the Iris
> campaign-grade lane, mirroring [[../libraries/storefront-campaign-grader]]) is not
> yet built. Rows are written by hand / `graded_by='human'` until it lands.

## Grain

**One row per campaign** — `campaign_id` is `unique` → grading is idempotent (a re-grade
UPDATEs in place).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `workspace_id` | uuid → [[workspaces]] | cascade |
| `campaign_id` | uuid → [[sms_campaigns]] | **UNIQUE** (`sms_campaign_grades_campaign_key`) — one grade row per campaign. cascade |
| `grade_initial` | int | 1–10 at early signal (clicks / early orders) |
| `grade_revised` | int | 1–10 after the coupon window closes (attributed revenue) — never overwrites `grade_initial` |
| `hypothesis_quality` | int | 1–10: was the theme/segment/timing a sound bet? **Independent of result** |
| `result_quality` | int | 1–10: did it convert? (separate axis) |
| `sent` | int | delivered recipients (KPI denominator) |
| `revenue_cents` | int | UTM-attributed revenue (KPI numerator) |
| `rev_per_send_cents` | int | `revenue_cents / sent` — **the KPI** |
| `reasoning` | text | evidence-based grader reasoning (Iris) |
| `graded_by` | text | `'iris'` \| `'human'` \| `'auto'` |
| `created_at` / `updated_at` | timestamptz | default `now()` |

## Indexes

- `unique (campaign_id)` — `sms_campaign_grades_campaign_key`, one grade per campaign +
  idempotent-upsert target.

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (cascade)
- `campaign_id` → [[sms_campaigns]].`id` (cascade)

## Gotchas

- **KPI = attributed revenue-per-send.** `rev_per_send_cents` is the reward Iris
  optimizes the bounded proxy toward — see [[../sms-segment-performance]] for which
  segments actually pay.
- **Hypothesis ≠ result.** `hypothesis_quality` and `result_quality` are independent
  axes — the grader must not reward outcome luck. Same invariant as
  [[storefront_campaign_grades]].
- **Both grades are kept.** `grade_initial` (early signal) is never overwritten by
  `grade_revised` (post-window attributed revenue) — the proxy-vs-reality gap stays
  auditable.
- **One row per campaign.** `campaign_id` is UNIQUE; grading is idempotent.
- The automated grader is not yet built — treat `graded_by='auto'`/`'iris'` rows as
  future state; today's rows are `'human'`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[sms_campaigns]] · [[storefront_campaign_grades]] · [[../inngest/sms-marketing]] · [[../sms-segment-performance]]
