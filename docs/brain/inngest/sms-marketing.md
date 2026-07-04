# inngest/sms-marketing

SMS Marketing Agent scheduling — the CMO/Iris **cadence engine**. A daily fan-out cron
finds every workspace with an active [[../tables/sms_marketing_policy]] and fires one
schedule event each; the per-workspace worker runs the agent's gate → freshness →
build+schedule loop. Thin wrappers — the logic lives in [[../libraries/sms-marketing-agent]].
The CMO-side mirror of the Storefront Optimizer cron pair.

**File:** `src/lib/inngest/sms-marketing.ts`

## Functions

Two functions, fan-out architecture (the cron only dispatches; the per-workspace
function does the work):

### `sms-marketing-cron`
- **Trigger:** cron `0 12 * * *` (12:00 UTC — daily)
- **Retries:** 1
- Finds every workspace with an **active** [[../tables/sms_marketing_policy]] and fires
  one `sms-marketing/schedule` event each. **Heartbeat on every tick** (incl. the
  no-active-policy path — no early return) so the freshness monitor sees a daily beat
  via `emitCronHeartbeat("sms-marketing-cron", …)`.
- **Timing is deliberate:** runs **AFTER** [[refresh-customer-segments]] (`0 11 * * *`,
  11:00 UTC) so the day's segments are fresh, and **BEFORE** the earliest 9am-Eastern
  send window (13:00 UTC) so morning campaigns have lead time to stage.

### `sms-marketing-schedule`
- **Trigger:** event `sms-marketing/schedule` (`{ workspace_id }`)
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.workspace_id" }]`
  (one run per workspace at a time — no double-scheduling)
- Calls `runSmsMarketingAgent(workspace_id)` and logs the structured result
  (status / theme / scheduled / skipped / reason). Never throws.

## The gate order (a rail at every step)

`evaluateSendGate` ([[../libraries/sms-marketing-agent]]) decides whether *now* is a
valid window, in strict order — **any failure is a rail (SKIP + record the reason),
never guess-and-execute** (CLAUDE.md § North star):

1. **Dormant** — `policy.active=false` ⇒ skip (silent — the common idle case).
2. **Window** — no `send_windows` entry for today's Central weekday ⇒ skip (silent).
3. **Weekly cap** — `weekly_send_cap` send-days already used this ISO week (or already
   sent today) ⇒ skip.
4. **Min gap** — last agent send-day within `min_days_between_sends` ⇒ skip.
5. **Theme coupon configured** — the day's window's theme has no `code`/`collection`
   in `theme_config` ⇒ skip + **escalate** (a couponless blast is a rail, not a guess).

Steps 1–2 are silent no-ops (not surfaced, so the recap doesn't flood); steps 3–5 write
a `sms_send_skipped` [[../tables/director_activity]] row for Iris.

## The segment-freshness RAIL

Even on a green gate, the agent **re-checks segment freshness before sending**
(`checkSegmentFreshness`): the subscribable book (`sms_marketing_status='subscribed'`,
good phone) must be **≥80% refreshed within 26h**. Below that it **blocks + escalates**
(`sms_send_blocked_stale_segments` in [[../tables/director_activity]]) rather than
texting a stale audience — the **SUMMERFIT lesson** ([[refresh-customer-segments]]: a
send once went out on a ~15-day-old snapshot). Escalate, don't send.

## The per-segment single-campaign build

On a passing gate + fresh book the agent builds **one campaign per segment** in
`policy.segment_scope` (the proven per-segment pattern — see the [[../../sms-marketing]]
skill), each stamped:

- `source='sms-agent'` + `agent_theme` = the window's theme (audit + grading provenance).
- `coupon_enabled=false` with the **pre-existing Shopify code** carried in the
  `/discount/{code}?redirect=/collections/{collection}` shortlink target — nothing new
  is minted.
- `included_segments=[segment]`; **`excluded_segments` excludes `active_sub`** — except
  for the `active_sub` campaign itself (a subscriber still gets its own targeted send).
- Body composed from [[../tables/sms_campaign_templates]] (`{hook}\n\n{cta}\n{shortlink}\n\n{signoff}`),
  GSM-7- and 160-char-gated; a segment with no template / non-GSM-7 / over-length body
  is skipped and logged.

Each built campaign fires `marketing/text-campaign.scheduled` → [[marketing-text]] runs
the actual Twilio send. A `scheduled_sms_campaign` [[../tables/director_activity]] row
records what + why (theme, offer, segments, skips).

## director_activity supervision

Every run records exactly one Iris-legible [[../tables/director_activity]] line under
`directorFunction: 'cmo'`. Action kinds:

- `scheduled_sms_campaign` — a send: theme, offer code/label, segment count, date/hour,
  freshness detail, any skipped segments.
- `sms_send_skipped` — a meaningful gate rail (cap / min-gap / no-coupon).
- `sms_send_blocked_stale_segments` — the freshness rail fired; escalated instead of
  texting a stale book.

## Tables written

- [[../tables/sms_campaigns]] (the campaigns it schedules)
- [[../tables/director_activity]] (its reasoning / supervision line)

## Tables read (not written)

- [[../tables/sms_marketing_policy]]
- [[../tables/sms_campaign_templates]]
- [[../tables/customers]] (freshness check)

## Downstream events sent

- `sms-marketing/schedule` (cron → per-workspace function; one per active workspace)
- `marketing/text-campaign.scheduled` (per built campaign → [[marketing-text]])

## Related

- [[marketing-text]] — the actual SMS send pipeline the built campaigns hand off to.
- [[refresh-customer-segments]] — the 11:00 UTC segment refresh this cron waits on.
- [[../tables/sms_marketing_policy]] · [[../tables/sms_campaign_templates]] — the
  policy + copy library.
- [[../libraries/sms-marketing-agent]] — the engine logic (gate + build).
- [[../functions/cmo]] — the owning function (Iris).

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]] · [[../sms-segment-performance]]
