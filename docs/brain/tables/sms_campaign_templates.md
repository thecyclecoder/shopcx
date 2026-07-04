# sms_campaign_templates

The **DB-driven copy library** for the SMS Marketing Agent — the per-(theme, segment)
hook / cta / signoff the agent composes each blast from. Copy is **never hardcoded**
(CLAUDE.md invariant): the agent reads this table, so Iris (or a human) edits the copy
without a deploy. Written + read alongside [[sms_marketing_policy]]. Migration
`20260704120000_sms_marketing_agent.sql`. RLS: authenticated SELECT, service-role
write. See [[../inngest/sms-marketing]].

**Primary key:** `id`

## Grain

**One row per `(workspace_id, theme, segment)`** (`unique`). `segment='*'` is the
theme's **default fallback** — used when a segment in `sms_marketing_policy.segment_scope`
has no segment-specific row for the active theme.

## Body composition

The agent composes the message body (`composeBody` in [[../libraries/sms-marketing-agent]])
as the canonical stacked-block SMS shape — matching the shipped July 4th send and
[[../inngest/marketing-text]] § Message body formatting:

```
{hook}

{cta}
{shortlink}

{signoff}
```

`{shortlink}` expands per-recipient to `superfd.co/{slug}/{short_code}` at send time
(~31 chars). The composed body must stay **GSM-7 only** and render **under 160 chars**
incl. the personal link, or the agent skips that segment ([[../libraries/sms-marketing-agent]]
`isGsm7` / `renderedLength`).

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id (`on delete cascade`) |
| `theme` | `text` | — | `'vip'` \| `'weekend'` |
| `segment` | `text` | — | archetype segment (e.g. `cycle_hitter`, `lapsed`) or `'*'` fallback |
| `hook` | `text` | — | block 1 (segment-specific opener) |
| `cta` | `text` | — | block 2 label above `{shortlink}` |
| `signoff` | `text` | — | last block: benefit payoff + urgency |
| `is_active` | `boolean` | — | default `true` · only active rows are loaded |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Indexes

- `unique (workspace_id, theme, segment)` — `sms_campaign_templates_key`, the
  one-copy-per-slot constraint + upsert target.

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (`on delete cascade`)

## Common queries

### Load a theme's active templates (what the engine does)
```ts
const { data } = await admin.from("sms_campaign_templates")
  .select("theme, segment, hook, cta, signoff")
  .eq("workspace_id", workspaceId).eq("theme", theme).eq("is_active", true);
// then: bySeg.get(segment) ?? bySeg.get("*")
```

## Seed

The migration seeds **14 rows** for Superfoods — the `vip` and `weekend` themes across
the scoped archetypes plus each theme's `'*'` fallback.

## Gotchas

- **Never hardcode SMS copy in code** — this table is the source of truth (CLAUDE.md).
  A hand-edited body in a script bypasses Iris's copy library.
- `segment='*'` is the **theme fallback**, resolved only when no exact-segment row
  exists for the active theme.
- The composed body is GSM-7- and 160-char-gated at send time — a template that
  renders long or non-GSM-7 causes the agent to **skip that segment** and log it, not
  send a truncated/UCS-2 message.
- Per-segment conversion (which copy/segment actually pays) → [[../sms-segment-performance]].

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../inngest/sms-marketing]] · [[../sms-segment-performance]]
