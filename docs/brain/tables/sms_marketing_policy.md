# sms_marketing_policy

The **control surface** for the SMS Marketing Agent (CMO / Iris) — the dormant
on-switch, the enforced cadence guardrails, the allowed send windows, the segment
allowlist, and the per-theme offer wiring the agent reads to bound every send. The
CMO-side mirror of [[storefront_optimizer_policy]] (the Growth Optimizer's control
surface): agent-**legible** + agent-**writable** (typed fields, `rationale`,
authorship) so Iris operates it — but the engine + cron read it **read-only and never
write their own policy** (authoring lives in [[../libraries/sms-marketing-policy-authoring]]).
With **`active=false` (the table default) the agent does not even propose** (fully
idle) — the safe-by-default invariant, enforced in [[../libraries/sms-marketing-agent]]
`evaluateSendGate`. Migration `20260704120000_sms_marketing_agent.sql`. RLS:
authenticated SELECT, service-role write. See [[../inngest/sms-marketing]] ·
[[../functions/cmo]].

**Primary key:** `id`

## Grain

**One row per workspace** (`workspace_id` is `unique`). No versioning — edits update
the single row in place (`updated_by` / `updated_at` stamp who last changed it).
Simpler than a policy-version ledger because the gate is a small, directly-editable
surface.

## Two-switch dormancy

The agent ships **doubly dormant**, mirroring [[storefront_optimizer_policy]]:

1. **`sms_marketing_policy.active`** — this row's on-switch (defaults `false`). Even
   with a fully-configured policy the cron skips a workspace whose row isn't `active`.
2. **`function_autonomy('cmo')`** — the CMO director's autonomy gate. Iris only reaches
   the activation lever once its function is granted operational autonomy.

Superfoods is **seeded `active=false`** by the migration's seed script (which stages
the policy + templates but leaves the switch off). Iris / Dylan flips it on via
[[../libraries/sms-marketing-policy-authoring]] `activateSmsPolicy` — the reversible
on/off the next cron tick re-reads.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · **unique** (`sms_marketing_policy_ws_key`) — one policy per workspace |
| `active` | `boolean` | — | default **`false`** · the on-switch. "the agent proposes + schedules sends at all." OFF ⇒ fully idle |
| `weekly_send_cap` | `integer` | — | default `2` · max campaign-events (send days) per ISO week |
| `min_days_between_sends` | `integer` | — | default `2` · fatigue guard between send days |
| `send_windows` | `jsonb` | — | default `[]` · the candidate slots the agent may fire in — `{ weekday:0-6 (0=Sun), hour:0-23, theme:'vip'｜'weekend' }[]`. The 5 windows Dylan named: **Sun AM · Mon AM · Tue PM · Thu AM · Sat AM**. Enforced in code, never narrative |
| `segment_scope` | `jsonb` | — | default `["cycle_hitter","lapsed","engaged","deep_lapsed","single_order","active_sub"]` · the allowlist the agent may text. **`cold` is never included** — the 92%-of-book spam tax ([[../sms-segment-performance]]) |
| `theme_config` | `jsonb` | — | default `{}` · per-theme offer wiring — `{ vip:{code,collection,discount_label}, weekend:{...} }`. Codes are **pre-existing Shopify codes** (the `coupon_enabled=false` path — nothing new is minted). Empty ⇒ the agent has no offer to send and **skips (a rail, not a guess)** |
| `created_by` | `text` | — | `agent` \| `human` (CHECK, default `human`) — lets Iris self-author |
| `updated_by` | `uuid` | ✓ | an `auth.users`.id (plain uuid, **no FK** — the pooler apply role lacks REFERENCES on the `auth` schema) · who last edited |
| `rationale` | `text` | ✓ | why this policy is set as it is (Iris legibility) |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Indexes

- `unique (workspace_id)` — `sms_marketing_policy_ws_key`, the one-policy-per-workspace
  constraint + upsert target.

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (`on delete cascade`)

## Common queries

### Load the workspace's policy (what the engine does)
```ts
const { data } = await admin.from("sms_marketing_policy")
  .select("workspace_id, active, weekly_send_cap, min_days_between_sends, send_windows, segment_scope, theme_config")
  .eq("workspace_id", workspaceId).maybeSingle();
```

### Find active workspaces (what the cron does)
```ts
const { data } = await admin.from("sms_marketing_policy")
  .select("workspace_id").eq("active", true);
```

## Gotchas

- The engine + cron **never** write this table — only Iris (or a human via the future
  dashboard) does, through [[../libraries/sms-marketing-policy-authoring]]. The engine
  reading its own writes would defeat supervisable autonomy.
- **`active=false` is the ship state.** Superfoods is seeded dormant; flipping it on is
  a deliberate `activateSmsPolicy` call.
- `send_windows` + `segment_scope` are **enforced in code**, not narrative — a weekday
  with no window is a no-op, and a segment outside the allowlist is never texted.
- `theme_config` with no `code`/`collection` for the day's theme is a **rail**: the
  agent skips + escalates rather than sending a couponless blast.
- `cold` must never be added to `segment_scope` — see [[../sms-segment-performance]].

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[storefront_optimizer_policy]] · [[../inngest/sms-marketing]] · [[../libraries/sms-marketing-policy-authoring]] · [[../functions/cmo]]
