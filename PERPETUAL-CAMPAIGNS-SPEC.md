# Perpetual Campaigns Spec

Shift SMS marketing from manual campaign-by-campaign sends (besides holidays) to a perpetually-running engine that:

1. Defines 3-5 reusable **series templates** (Flash, VIP, Weekend Only, etc.) with a 3-day arc
2. Runs a **daily qualifier** that classifies every SMS-subscribed customer into archetype state
3. **Enrolls** qualified customers into the right series automatically
4. **Walks them through** the 3-step send arc at their local times
5. Applies **suppression + sunset** rules so we don't burn the list
6. Later: layers in **cross-sell series** (post-purchase product affinity)

After this is live, only holiday/event-based campaigns are manual. Everything else is auto-fed from the archetype state.

This is the productized form of the segmentation analysis work — the converter analysis tells us WHO converts; this spec is how we operationalize sending to them perpetually.

---

## Why this exists

**Today:** One person manually creates and schedules each campaign. Audience selection is ad-hoc. Frequency control is human-managed. Lift on a per-customer basis is invisible until after the fact.

**End state:** The system maintains a continuous classifier ("you are a `cycle_hitter` today"), continuously matches that classification to a relevant series ("`cycle_hitter` + `replenishment_ratio` 1.0-1.5 → Flash Sale series"), and continuously feeds qualified customers through messaging while respecting frequency caps and conversion cooldowns. Manual work shifts to creative + holiday campaigns only.

**Cost savings (rough):** today's Klaviyo-style blast costs ~$15-25K/campaign in SMS fees at 0.1% conversion. Targeted by archetype, we'd send to ~20-30% of audience for the same or higher conversion count — direct 70-80% cost reduction with equal or better revenue.

---

## Architecture

```
                     daily 4 AM CT cron
                             │
              ┌──────────────┼──────────────┐
              ▼                              ▼
      Archetype Qualifier            Enrollment Engine
      (per customer)                 (per series)
              │                              │
              ▼                              │
  customer_archetype_state                   │
       (updated daily)                       │
                                             ▼
                              sms_series_enrollments
                              (one per (customer, series, run))
                                             │
                                             ▼
                                 every-5-min send tick
                                             │
                                             ▼
                                  Twilio send (step N of 3)
                                             │
                                             ▼
                              Conversion attribution
                              (utm or storefront pixel)
                                             │
                                             ▼
                              Outcome → cooldown / sunset rules
```

---

## 1. Series templates

### `sms_series` table

```sql
CREATE TABLE sms_series (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,             -- "flash", "vip", "weekend"
  name              TEXT NOT NULL,             -- customer-facing label (internal)
  status            TEXT NOT NULL DEFAULT 'draft',  -- draft, active, paused
  priority          INTEGER NOT NULL DEFAULT 100,   -- lower wins when customer qualifies for multiple
  -- Eligibility rule (DSL or JSON, see § 2)
  eligibility       JSONB NOT NULL DEFAULT '{}',
  -- After completion, customer can't re-enroll for this many days
  cooldown_days     INTEGER NOT NULL DEFAULT 14,
  -- After non-converting N times in a row, sunset for sunset_days
  sunset_after      INTEGER NOT NULL DEFAULT 3,
  sunset_days       INTEGER NOT NULL DEFAULT 60,
  -- Coupon — one shared code per series, regenerated nightly if expired
  coupon_enabled    BOOLEAN NOT NULL DEFAULT false,
  coupon_discount_pct INTEGER,
  coupon_expires_days INTEGER NOT NULL DEFAULT 7,
  active_coupon_code   TEXT,
  active_coupon_expires_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
```

### `sms_series_steps` table

```sql
CREATE TABLE sms_series_steps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id         UUID NOT NULL REFERENCES sms_series(id) ON DELETE CASCADE,
  step_order        INTEGER NOT NULL,          -- 0, 1, 2
  days_after_enrollment INTEGER NOT NULL,      -- 0, 1, 2
  target_local_hour INTEGER NOT NULL DEFAULT 11,
  message_body      TEXT NOT NULL,
  media_url         TEXT,
  UNIQUE (series_id, step_order)
);
```

### Seeded V1 series

| slug | name | priority | eligibility |
|---|---|---|---|
| `flash` | Flash Sale | 100 | `pre_send_orders >= 2 AND replenishment_ratio BETWEEN 0.5 AND 3.0` |
| `vip` | VIP Sale | 50 | `pre_send_ltv_cents >= 100000 AND active_sub_at_send = true` |
| `weekend` | Weekend Only | 200 | `pre_send_orders >= 1 AND day_of_week IN (Fri, Sat)` |

Day-1/2/3 copy honesty: see § 5 below.

---

## 2. Eligibility DSL

`sms_series.eligibility` is a JSON object compiled to a SQL predicate against the qualifier's feature table. Example:

```json
{
  "all_of": [
    { "feature": "pre_send_orders", "op": ">=", "value": 2 },
    { "feature": "replenishment_ratio", "op": "between", "value": [0.5, 3.0] },
    { "feature": "is_active_sms_subscriber", "op": "=", "value": true }
  ]
}
```

Supported ops: `=`, `!=`, `>`, `>=`, `<`, `<=`, `between`, `in`. Supported logical groupers: `all_of`, `any_of`. Compiled at qualifier time, not stored per-evaluation.

---

## 3. Daily qualifier

Cron `0 10 * * *` (4 AM CT). For every SMS-subscribed customer in the workspace:

### Inputs
- `orders` table → `pre_send_orders`, `pre_send_ltv_cents`, `days_since_last_order`, `mean_reorder_gap_days`, `replenishment_ratio`
- `subscriptions` table → `active_sub_at_send`
- `klaviyo_profile_events` (incremental synced by cron daily) → `clicked_sms_60d`, `opened_email_60d`, etc.
- `customers.subscription_status`, `email_marketing_status`, `sms_marketing_status`, `retention_score`

### Output
Insert/upsert into `customer_archetype_state`:

```sql
CREATE TABLE customer_archetype_state (
  workspace_id      UUID NOT NULL,
  customer_id       UUID NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archetype         TEXT NOT NULL,              -- cycle_hitter, lapsed, just_ordered, engaged, single_order, cold, lurker
  features          JSONB NOT NULL,             -- snapshot of feature set used
  PRIMARY KEY (workspace_id, customer_id)
);
```

This is the runtime substrate the enrollment engine reads. It also serves as the `campaign_audience_features` table mentioned in the SMS roadmap — same thing, different name.

### Why pre-compute daily, not at enrollment time

138K subscribers × 13 features × 5 series predicate evaluations is too slow at enrollment time. Daily batch compute, then enrollment queries are pure index lookups against `customer_archetype_state`.

---

## 4. Enrollment engine

Same cron, runs after the qualifier finishes. For each `active` series:

```pseudocode
candidates = SELECT customer_id FROM customer_archetype_state
             WHERE workspace_id = $ws
             AND eligibility_predicate_matches(features)
             AND customer_id NOT IN current_enrollments
             AND customer_id NOT IN sunset
             AND customer_id NOT IN frequency_capped
             AND customer_id NOT IN converted_recently
             AND customer_id NOT IN cooldown_for_this_series

FOR each candidate:
  INSERT INTO sms_series_enrollments (
    customer_id, series_id, enrolled_at, status='active'
  )
```

### `sms_series_enrollments` table

```sql
CREATE TABLE sms_series_enrollments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL,
  series_id         UUID NOT NULL REFERENCES sms_series(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id),
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  features_snapshot JSONB,                       -- archetype + features at enrollment time
  status            TEXT NOT NULL DEFAULT 'active',  -- active, completed, converted, opted_out, suppressed
  current_step      INTEGER NOT NULL DEFAULT 0,
  next_send_at      TIMESTAMPTZ,                 -- resolved local time for next step
  completed_at      TIMESTAMPTZ,
  converted_at      TIMESTAMPTZ,                 -- if customer placed an order during the series
  converted_order_id UUID REFERENCES orders(id)
);
CREATE INDEX ON sms_series_enrollments (next_send_at) WHERE status = 'active';
CREATE INDEX ON sms_series_enrollments (workspace_id, customer_id);
```

### Conflict resolution: multi-series qualification

A customer may match `flash` + `vip` + `weekend` on the same day. Rules:

1. Single-flight: customer can only be `active` in ONE series at a time.
2. Priority order: lowest `priority` value wins. (`vip` priority=50 beats `flash` priority=100.)
3. If they don't qualify for VIP next time, they get Flash next.

The qualifier writes to `customer_archetype_state` once; the enrollment engine respects priority when picking which series to enroll into.

---

## 5. Step walker / send tick

Extends the existing `textCampaignSendTick` pattern. Runs every 5 min.

```pseudocode
due = SELECT * FROM sms_series_enrollments
      WHERE status = 'active' AND next_send_at <= now()
      LIMIT 500

FOR each enrollment:
  step = (SELECT * FROM sms_series_steps WHERE series_id = enrollment.series_id AND step_order = enrollment.current_step)
  send_sms(customer.phone, step.message_body)
  IF enrollment.current_step >= max_step:
    UPDATE enrollment SET status='completed', completed_at=now(), next_send_at=null
  ELSE:
    next_step_time = compute_local_time(customer, next_day_offset, step.target_local_hour)
    UPDATE enrollment SET current_step = current_step+1, next_send_at = next_step_time
```

Reuses 100% of:
- Per-recipient timezone resolution (`timezone-resolver.ts`)
- Twilio send code (`marketing-text.ts`)
- Coupon substitution (`{coupon}` placeholder)
- Shortlink substitution (`{shortlink}` placeholder)

### Day 3 copy honesty

The "Sale extended!" framing is the trickiest copy. Three options ranked by integrity:

1. **(Best)** Day 3 only fires if Day 1+2 had no engagement (no click, no order, no ATC) for this specific customer. Then the "extended just for you" framing is honest because we made a real exception.
2. **(Acceptable)** Day 3 says "Last chance — code expires tonight" instead of "Extended." No claim of extension, just urgency.
3. **(Avoid)** Day 3 fires unconditionally with "Extended one more day!" — script-y, savvy customers will catch on.

Recommend (1) when feasible; (2) as default fallback.

---

## 6. Suppression + sunset rules

### Frequency cap (global)
```sql
no SMS to customer if last SMS sent < 7 days ago, EXCEPT for holiday campaigns
```

### Conversion cooldown
```sql
no enrollment if customer placed an order in last 30 days
```

### Non-responder sunset
```sql
if customer has completed sunset_after series in a row (3 by default)
without converting, mark suppression record for sunset_days (60 by default)
```

### Cooldown per series
```sql
no re-enrollment in the SAME series for cooldown_days
```

### Holiday override
```sql
when a holiday campaign is scheduled, suspend all perpetual enrollments
for 48h around the send window
```

### Suppression table

```sql
CREATE TABLE sms_series_suppressions (
  workspace_id      UUID NOT NULL,
  customer_id       UUID NOT NULL,
  reason            TEXT NOT NULL,             -- frequency_cap, conversion_cooldown, sunset, opted_out, holiday_override
  suppressed_until  TIMESTAMPTZ NOT NULL,
  series_id         UUID REFERENCES sms_series(id),  -- null = global, set = series-specific
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, customer_id, reason, series_id)
);
```

The qualifier checks this table before enrolling.

---

## 7. Calibration loop

Every quarter (or on demand), re-run `scripts/segment-analysis-3mo.ts` with the latest 90 days of campaign data + Received SMS recipient lists. Compare:

- Conversion rate per (archetype, series) — which combos actually perform
- Missed opportunity per series — how many customers qualify but never get enrolled (frequency cap dropping them)
- Sunset rate — what % of customers end up in non-responder suppression

Update series `eligibility` JSON based on findings. Save calibration results to `sms_series_calibration` table for audit.

---

## 8. Cross-sell layer (Phase 3)

The same machinery, different trigger:

- **Trigger:** `order_created` webhook OR a "post-purchase" cron looking at orders in last 24h
- **Eligibility:** ordered product X AND has never ordered product Y AND there's a known affinity (X→Y in the product affinity model)
- **Series:** "After Coffee" series → Day 1 introduces creamer with social proof, Day 2 first-purchase discount, Day 3 last-call

Cross-sell uses the same `sms_series` + `sms_series_enrollments` machinery. Only difference is enrollment trigger (event-driven vs cron).

The product affinity model itself is a separate spec — needs cohort co-purchase analysis. Defer until V1 perpetual engine is shipping consistent results.

---

## Phased build

| Phase | Scope | Time | Dependency |
|---|---|---|---|
| **Phase 0** (now) | Finish Received SMS backfill + case-control analysis | in flight | — |
| **Phase 1** | V1 segment toggle in existing campaign builder (`pre_send_orders >= 1`) | ~3 days | Phase 0 |
| **Phase 2** | Single-series MVP — qualifier + enrollment + send tick + frequency cap | ~1-2 weeks | Phase 1 |
| **Phase 3** | Multi-series + priority + conflict resolution + sunset logic | ~1-2 weeks | Phase 2 |
| **Phase 4** | Cross-sell trigger + product affinity model | ~2-3 weeks | Phase 3 |
| **Phase 5** | Performance feedback loop — auto-tune eligibility based on observed lift | ongoing | Phase 4 |

---

## File changes (Phase 2 estimate)

| File | Change |
|---|---|
| `supabase/migrations/XXX_perpetual_campaigns.sql` | All four new tables |
| `src/lib/inngest/archetype-qualifier-cron.ts` | NEW — daily 4 AM CT cron that recomputes `customer_archetype_state` |
| `src/lib/inngest/series-enrollment-cron.ts` | NEW — runs after qualifier; enrolls candidates |
| `src/lib/inngest/series-send-tick.ts` | NEW — every 5 min; walks active enrollments through steps |
| `src/lib/series-eligibility.ts` | NEW — compiles the eligibility JSON DSL to SQL predicates |
| `src/lib/series-suppression.ts` | NEW — frequency cap + cooldown + sunset checks |
| `src/app/dashboard/marketing/series/page.tsx` | NEW — list view of all series |
| `src/app/dashboard/marketing/series/[id]/page.tsx` | NEW — series detail: edit steps, eligibility, view enrollment stats |
| `src/app/api/inngest/route.ts` | Register the new functions |

---

## Key risks

| Risk | Mitigation |
|---|---|
| SMS fatigue from too-frequent sends | Global 7d frequency cap; per-customer opt-out monitoring; sunset rule |
| Day 3 "extended" framing reads as manipulative | Use conditional Day 3 OR rewrite copy to "last chance / expires tonight" |
| Series exclusivity dilutes | Frame series as "this is what we send to X" not "this is rare"; control by eligibility, not by frequency |
| Holiday campaign collisions | 48h holiday-override suspension; clear UI surface so admin sees what's suspended |
| Eligibility DSL is too rigid | Add SQL escape hatch (raw predicate) for power-user series; keep DSL for the 80% case |
| Migration cost from manual to auto | Phase 1 ships the segment toggle FIRST so admins can A/B against blast sends; build trust before going perpetual |

---

## Open questions for later

- How do we handle **subscribers who pause/resume Klaviyo-style** (snooze marketing for N days)?
- Should the customer be able to **self-select archetype** ("I'm a busy parent who only buys when X")? Probably not for V1 — let behavior speak.
- **Pricing dynamics:** if a customer always converts on 25% off, do we lower the standing series coupon? Or hold it firm to preserve margin? (Probably hold firm — the goal is to identify high-intent customers, not race-to-bottom on discount.)
- **Cross-workspace:** this spec assumes single workspace (Superfoods). When we onboard a second customer, series templates + eligibility need workspace-scoped defaults plus override patterns.
