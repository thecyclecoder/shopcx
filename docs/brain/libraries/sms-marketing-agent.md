# libraries/sms-marketing-agent

The **READ-side engine** of the CMO/Iris SMS Marketing Agent. Decides whether *now* is
a valid cadence window and, if so, builds + schedules one theme's worth of per-segment
promotional campaigns from the DB-driven copy library
([[../tables/sms_campaign_templates]]), gated by the bounded proxy in
[[../tables/sms_marketing_policy]] and supervised by Iris via
[[../tables/director_activity]]. The CMO-side mirror of the Storefront Optimizer agent.

> **North star (CLAUDE.md § North star).** This agent optimizes a **bounded proxy** —
> attributed **revenue-per-send** ([[../sms-segment-performance]]) within the policy's
> weekly cap + segment scope + send windows. **Iris owns the objective** (owned-channel
> revenue) and supervises. Every rail (dormant policy, weekly cap, min gap, stale
> segments, no coupon configured) ⇒ **SKIP + record the reason**, never
> guess-and-execute. The engine is **read-only** over the policy (authoring lives in
> [[sms-marketing-policy-authoring]]); it writes only [[../tables/sms_campaigns]] +
> [[../tables/director_activity]].

**File:** `src/lib/sms-marketing-agent.ts` · Unit-tested in
`src/lib/sms-marketing-agent.test.ts` · Reads [[../tables/sms_marketing_policy]] +
[[../tables/sms_campaign_templates]] + [[../tables/customers]] · Called by
[[../inngest/sms-marketing]].

## Exports

### `evaluateSendGate(policy, now, recentAgentSendDates)` → `SendGateDecision`
The **pure cadence decision** (exported for unit testing) — is `now` a valid window,
given the policy + the agent's recent send days? Enforces in order: **active → today
has a window → weekly cap not hit → min-gap since last send → theme has coupon
wiring**. Any failure returns `{ send:false, reason }`; a pass returns
`{ send:true, theme, hour, dateStr }`. No I/O.

### `runSmsMarketingAgent(workspaceId, now?)` → `Promise<AgentRunResult>`
The **orchestrator** — one autonomous run for a workspace. Loads the policy, pulls the
last-14-day agent send days, evaluates the gate, then the freshness rail, and — only if
both pass — builds + schedules one theme's per-segment campaigns (`source='sms-agent'`,
`coupon_enabled=false`, code in the `/discount/` target, `active_sub` excluded except
its own campaign), firing `marketing/text-campaign.scheduled` per campaign. Records a
[[../tables/director_activity]] row either way. **Never throws** — returns a structured
`AgentRunResult` the cron logs.

### `loadSmsPolicy(admin, workspaceId)` → `Promise<SmsMarketingPolicy | null>`
Loads the workspace's single policy row (`maybeSingle`). `null` ⇒ the agent treats SMS
marketing as OFF.

### `composeBody({ hook, cta, signoff })` → `string`
Composes the canonical block layout `` `${hook}\n\n${cta}\n{shortlink}\n\n${signoff}` ``
(the `{shortlink}` token expands per-recipient at send time).

### `renderedLength(body)` → `number`
The body's real rendered length — swaps the `{shortlink}` token for the ~31-char
personal link (`superfd.co/{slug}/{short_code}`). Used to enforce the 160-char GSM-7
single-segment cap.

### `isGsm7(s)` → `boolean`
True iff every char is GSM-7 (ASCII) — no emoji / curly quotes / em-dash. A non-GSM-7
body drops the segment cap to 70 (UCS-2), so the agent skips that segment.

### `centralDay(now)` → `{ weekday, dateStr }`
Central-time (`America/Chicago`) calendar parts for an instant — `weekday` (0=Sun) +
`YYYY-MM-DD` — so "today" and the send date match how recipients experience the day.

### Types
`SmsMarketingPolicy`, `SmsSendWindow` (`{ weekday, hour, theme }`), `SmsThemeOffer`
(`{ code, collection, discount_label }`), `SmsTemplate`, `SendGateDecision`,
`AgentRunResult`.

## Callers

- [[../inngest/sms-marketing]] — `sms-marketing-schedule` calls `runSmsMarketingAgent`;
  `evaluateSendGate` + the pure helpers are also unit-tested directly.

## Gotchas

- **Read-only over the policy.** This engine never writes
  [[../tables/sms_marketing_policy]] — only Iris does, via
  [[sms-marketing-policy-authoring]]. The engine reading its own writes would defeat
  supervisable autonomy.
- **Every rail is a SKIP, not a guess.** Dormant / no window / cap / gap / no coupon /
  stale segments all short-circuit with a recorded reason; the freshness + no-coupon
  rails additionally **escalate** via [[../tables/director_activity]].
- **Freshness ≥80% within 26h** — the SUMMERFIT staleness rail. Below it the agent
  blocks + escalates rather than texting a stale book ([[../inngest/refresh-customer-segments]]).
- **Central-time calendar.** Windows + send dates are computed in `America/Chicago`, not
  UTC — `centralDay` anchors the weekday to avoid tz drift.
- **`active_sub` self-exclusion.** Every non-`active_sub` campaign excludes `active_sub`;
  the `active_sub` campaign includes it — subscribers get their own targeted send, never
  a duplicate.
- Body must be GSM-7 and render <160 chars incl. the personal link, or the segment is
  skipped + logged — never a truncated/UCS-2 send.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/sms_marketing_policy]] · [[../tables/sms_campaign_templates]] · [[sms-marketing-policy-authoring]] · [[../inngest/sms-marketing]] · [[../sms-segment-performance]] · [[../functions/cmo]]
