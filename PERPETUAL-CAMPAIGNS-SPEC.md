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
  angle             TEXT NOT NULL,             -- "flash_sale", "exclusive_invite", "restock_reminder", etc. — see § 1 angle taxonomy
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

### Series = creative rotation, NOT archetype targeting

The point of having 3-5 series is **rotation, not different audiences**. The same eligible customers cycle through different creative each run so they don't see "Flash Sale!" every weekend. Customer A might see:

- Run 1 (this weekend): Flash Sale creative
- Run 2 (next weekend): Weekend Only creative
- Run 3 (weekend after): Founder's Favorite creative
- Run 4: back to Flash Sale (now meaningfully rotated, doesn't feel repetitive)

The exception is **tiers** — a VIP tier exists because VIPs should get exclusive messaging that non-VIPs don't see. Inside a tier, multiple series rotate.

### Angles — the persuasion dimension

Every series has an **angle** — the psychological hook of the message. Different angles work for different archetypes:
- A `lapsed` customer might convert on "time to restock" but ignore "flash sale" because they're not actively shopping
- An `engaged` customer might convert on "exclusive invite" because they want to feel chosen
- A `just_ordered` customer probably ignores everything except "new arrival"

We track per-(angle, archetype) conversion rate continuously. Over time, eligibility rules evolve to route archetypes to their highest-converting angle. Underperforming angles get retired; high-performing ones get iterated on.

### V1 angle taxonomy

| angle | persuasion type | example hook |
|---|---|---|
| `flash_sale` | urgency | "1 day only — code FL40 for 40% off" |
| `weekend_only` | casual scarcity | "Weekend pricing — Sat/Sun only" |
| `restock_reminder` | utility | "It's been ~30 days since your last order. Time to restock?" |
| `exclusive_invite` | status | "You've been hand-picked for early access to our new flavor" |
| `vip_early_access` | tier status | "VIPs only — 48h head start on our spring sale" |
| `miss_you` | emotional | "We miss you. Here's a special price to come back" |
| `sale_extended` | second chance | "Last chance — your code expires tonight" (used as Day-3 step within other angles) |
| `bestseller_back` | social proof | "Cocoa French Roast is back — 92% of customers reorder" |
| `new_arrival` | novelty | "Just launched: Maple Cinnamon. Try it 25% off" |
| `founders_fave` | personality | "Andy's pick of the month — 25% off this week" |

Angles are extensible — admin can add new ones. We seed with these 10 as a starting taxonomy.

### Seeded V1 series

All series share the same baseline eligibility (`pre_send_orders >= 1 AND sms_marketing_status = 'subscribed' AND no recent cooldown`). The differentiator is the **angle** + an optional tier.

| slug | angle | tier | notes |
|---|---|---|---|
| `flash` | `flash_sale` | general | The urgency variant |
| `weekend` | `weekend_only` | general | Friday-Sunday timing |
| `founders_fave` | `founders_fave` | general | Brand-personality angle |
| `restock` | `restock_reminder` | general | Cycle-aware (uses replenishment ratio) |
| `comeback` | `miss_you` | general | Targeted at lapsed via eligibility, not just at all |
| `vip` | `vip_early_access` | vip | VIPs only |

VIP tier filter: `pre_send_ltv_cents >= 100000 AND active_sub_at_send = true`. VIPs are eligible for both the VIP series AND the general rotation; the rotation engine picks one per run, with VIP-tier series getting precedence within their tier.

Day-1/2/3 copy honesty: see § 5 below.

---

## 1b. Rotation engine

The core enrollment question becomes: "of all series this customer is eligible for and hasn't seen recently, which goes out next?"

### Per-customer rotation state

```sql
CREATE TABLE customer_series_rotation (
  workspace_id      UUID NOT NULL,
  customer_id       UUID NOT NULL,
  series_id         UUID NOT NULL REFERENCES sms_series(id) ON DELETE CASCADE,
  last_received_at  TIMESTAMPTZ NOT NULL,
  receive_count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, customer_id, series_id)
);
```

One row per (customer, series) the customer has been enrolled in. Updated on every enrollment.

### Rotation pick logic

For each candidate customer on enrollment day, in this order:

1. **Filter to eligible series** — series.status='active' AND tier eligibility matches customer's archetype state AND `customer NOT IN customer_series_rotation WHERE last_received_at > now() - tier_rotation_window`
2. **Rank remaining by `last_received_at` ascending** — never-seen series rank first, oldest-seen series rank second, etc.
3. **Pick the top** — enroll the customer in that series

This guarantees:
- Customer sees every series in a tier before repeating
- Once they've seen all, they get the one they haven't seen in the longest time
- A new series ships at any time and slots into the rotation naturally

### Tier rotation windows

A series within the "general" tier shouldn't repeat for ≥ N runs. With 4 general series and weekly cadence, full rotation = 4 weeks. So `tier_rotation_window = 4 weeks` for the general tier means a customer cycles through all 4 before any repeats.

```sql
ALTER TABLE sms_series ADD COLUMN tier TEXT NOT NULL DEFAULT 'general';
ALTER TABLE sms_series ADD COLUMN tier_rotation_weeks INTEGER NOT NULL DEFAULT 4;
```

### Priority vs rotation

The `priority` column from § 1 becomes secondary — it only resolves ties when two series within the same tier have identical `last_received_at` (e.g. customer's first-ever enrollment). Use it for "show this newest series first" or "always prefer this when otherwise equal."

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

### Conflict resolution: multi-series eligibility via rotation

A customer is typically eligible for multiple series (since they share the baseline eligibility rule). Pick via the rotation logic from § 1b:

1. **Single-flight** — customer can only be `active` in ONE series at a time. If they have an active enrollment, no new one is created.
2. **Tier filter first** — VIPs get VIP-tier series picked over general-tier when both apply. Non-VIPs only see general.
3. **Within a tier, rotate by `last_received_at`** — never-seen series first, then longest-not-seen. This is what makes "Flash → Weekend → Founder's Favorite → Flash" feel intentional rather than spammy.
4. **`priority` is a tiebreaker** — only matters when two series have identical rotation state (e.g. first-ever enrollment for a new customer).

The qualifier writes archetype state daily; the enrollment engine joins it with `customer_series_rotation` to pick the right next-in-rotation series per customer.

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

## 5b. Smart sending

Three layers of intelligence on top of basic enrollment + send. Each is independent — they compose.

### Per-customer optimal send time

11 AM local is a global default; customers don't all click at 11. We compute per customer (during the daily qualifier) the modal hour-of-day and day-of-week of their engagement:

- `optimal_click_hour` — mode of (datetime hour, local time) for Clicked SMS + Clicked Email events in last 180d
- `optimal_purchase_hour` — mode of (datetime hour, local time) for Placed Order events in last 180d
- `optimal_dow` — mode of day-of-week of any of the above

Stored in `customer_archetype_state.features` as a sub-object:

```json
{
  "optimal_click_hour": 19,
  "optimal_purchase_hour": 20,
  "optimal_dow": 6,
  "send_time_sample_size": 12
}
```

When scheduling the next step send for an enrollment, use the customer's `optimal_click_hour` if `send_time_sample_size >= 3`. Otherwise fall back to the series step's `target_local_hour`. This is Klaviyo's "Smart Send Time" feature, but built on our own data.

### Payday-aware scheduling

Dunning already encodes this (`src/lib/dunning.ts`) — retries fire on 1st, 15th, Fridays, last business day of the month at 7 AM Central. Same money-availability logic applies to marketing: people are more receptive to "spend" messages when their accounts have just been replenished.

Make this a per-series opt-in via a new column:

```sql
ALTER TABLE sms_series ADD COLUMN payday_aware BOOLEAN NOT NULL DEFAULT false;
```

Recommended defaults:
- `flash` — `payday_aware = true`
- `vip` — `payday_aware = true`
- `weekend` — `payday_aware = true` (Fridays already line up; explicit flag means the system would also pick up 1st/15th when they fall mid-week)
- Cross-sell series — `payday_aware = false` (these are behavioral triggers tied to a recent order, not money triggers)

**Enrollment logic when `payday_aware = true`:**

```
nearest_payday = next of: today (if payday), or 1st, 15th, Friday, last-biz-day in the next 3 days
IF nearest_payday is within 3 days:
  enroll, schedule Day 0 send for nearest_payday at customer's optimal_click_hour
ELSE:
  defer enrollment by 1 day, re-check tomorrow
```

So a customer who qualifies on a Monday for a payday-aware series sits in the qualifier pool until Friday, when they enroll and the 3-day arc starts. Day 1 = Friday, Day 2 = Saturday, Day 3 = Sunday — perfect weekend buying window.

### Multi-archetype lockout (hardened single-flight)

The spec already states a customer can only be `active` in ONE series at a time. We extend that with a **post-completion lockout**: once a customer completes (or converts on) any series, they're locked out of *all* series for `global_lockout_days` (default 14d), regardless of which archetypes they currently fit.

This prevents the "VIP today, Flash tomorrow, Weekend Friday" runaway when overlapping archetypes change quickly.

```sql
ALTER TABLE sms_series_suppressions ADD COLUMN reason_type TEXT NOT NULL DEFAULT 'series_specific';
-- 'global_lockout' = suppress all series; 'series_specific' = only this one
```

On completion, the enrollment engine writes a `global_lockout` suppression row covering all series for that customer for the lockout window.

### Implementation order within Phase 2

1. Smart send time computation — adds ~50 lines to the qualifier cron
2. Payday-aware enrollment — small change to enrollment logic + the new `payday_aware` column
3. Global lockout — extension of existing suppression table

All three are inexpensive to add and dramatically improve the engine's hit rate without making the architecture more complex.

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

## 7. Angle performance attribution

This is the learning loop. Without it, the engine is just automation; with it, the engine gets better over time.

### What we measure

For every enrollment, we already capture `features_snapshot` (the customer's archetype + features at enrollment time) and `converted_at` (whether they bought during the series window). Joined to `sms_series.angle`, we get the conversion-rate matrix:

```sql
SELECT
  s.angle,
  e.features_snapshot->>'archetype' AS archetype,
  COUNT(*) AS enrollments,
  COUNT(*) FILTER (WHERE e.converted_at IS NOT NULL) AS conversions,
  ROUND(100.0 * COUNT(*) FILTER (WHERE e.converted_at IS NOT NULL) / COUNT(*), 2) AS conversion_pct
FROM sms_series_enrollments e
JOIN sms_series s ON s.id = e.series_id
WHERE e.enrolled_at >= now() - interval '90 days'
GROUP BY s.angle, e.features_snapshot->>'archetype'
ORDER BY s.angle, conversion_pct DESC;
```

Sample output:

| angle | archetype | enrollments | conv | conv % |
|---|---|---|---|---|
| restock_reminder | lapsed | 4,200 | 380 | 9.0% |
| restock_reminder | cycle_hitter | 3,800 | 290 | 7.6% |
| flash_sale | engaged | 1,100 | 95 | 8.6% |
| flash_sale | lapsed | 4,500 | 180 | 4.0% |
| flash_sale | cycle_hitter | 4,000 | 160 | 4.0% |
| exclusive_invite | engaged | 900 | 110 | 12.2% |
| miss_you | lapsed | 2,800 | 190 | 6.8% |

**What this tells us:**
- `restock_reminder` wins on lapsed AND cycle_hitter — should over-route them here
- `exclusive_invite` wins on engaged — gives them a strong status framing
- `flash_sale` underperforms restock_reminder on lapsed (4% vs 9%) — should de-prioritize flash for that archetype

### How to surface this

Admin UI page: `/dashboard/marketing/text/angle-performance`. Heatmap of angle × archetype with conversion %. Sortable, filterable, shows enrollment volume + 90d trend.

### Automatic eligibility tuning (Phase 5)

Once we have enough enrollments (≥500 per cell), the system can auto-tune routing:

- If `angle X / archetype Y` significantly outperforms the cohort average → boost eligibility weight to route more of `Y` to `X`
- If `angle X / archetype Y` significantly underperforms AND has had ≥1000 enrollments → flag for retirement or copy iteration
- Per (angle, archetype) eligibility weights stored in `sms_series_angle_weights` table; rotation engine considers weight when picking next series

This is the "learning" — the spec sets up the data; the analysis runs continuously; the routing improves quarter-over-quarter without manual rule changes.

### Calibration loop (analyst-driven)

Every quarter (or on demand), re-run `scripts/segment-analysis-3mo.ts` with the latest 90 days of campaign data + Received SMS recipient lists. Outputs:

- Conversion rate per (angle, archetype) — confirms which combos actually perform
- Missed opportunity per angle — how many customers fit the high-converting cell but never get enrolled (frequency cap, sunset, conflict drops them)
- Sunset rate — what % of customers end up in non-responder suppression
- **Angle saturation curve** — does conversion rate flatten or decline as enrollment volume per angle grows? Tells us when to spawn a copy variant within an angle

Update series eligibility + angle weights based on findings. Save calibration results to `sms_series_calibration` table for audit.

### When to spawn a copy variant within an angle

The angle taxonomy is the **strategy** layer; specific copy is the **tactics** layer. Once `restock_reminder` clearly wins on lapsed customers, spawn 2-3 copy variants within that angle:
- "It's been ~30 days since your last order. Time to restock?"
- "Your last order was Mar 15. Reorder before you run out?"
- "Hey, just a heads up — based on your usual order timing, you're probably running low."

Same angle, different copy. A/B test within the angle. Keep the winner, retire the others. Iterate.

The architecture supports this naturally: same angle, multiple `sms_series` rows with that angle. The rotation engine picks based on `last_received_at` ascending — so copy variants rotate. Performance attribution still works because we group by angle, not by series.

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
