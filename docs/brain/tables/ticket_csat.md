# ticket_csat

CSAT responses — one row per ticket that the customer completed the survey on. Only collected when the customer confirms "Yes, resolved" on the survey gate; "No" reopens the ticket and records nothing here.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `ticket_id` | `uuid` | — | UNIQUE · → [[tickets]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `rating` | `int4` | — | 1-5, CHECK constrained |
| `comment` | `text` | ✓ | optional free-text |
| `resolution_category` | `text` | ✓ | always `resolved` for v1 (the survey gate filters out unresolved cases up front) |
| `classification_reason` | `text` | ✓ | reserved — Haiku classification path not wired in v1 |
| `ai_classified_at` | `timestamptz` | ✓ | reserved |
| `points_awarded` | `int4` | — | default: `0` — 500 once the survey is submitted |
| `points_awarded_at` | `timestamptz` | ✓ |  |
| `submitted_at` | `timestamptz` | — | default: `now()` |
| `excluded_at` | `timestamptz` | ✓ | NULL = counted in stats; set = owner soft-excluded this response |
| `excluded_by` | `uuid` | ✓ | → `auth.users`.id (ON DELETE SET NULL) — owner who excluded |
| `exclusion_reason` | `text` | ✓ | free-text reason captured at exclude time |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### Average CSAT for a workspace over a window
```ts
const since = new Date(Date.now() - 30 * 86400e3).toISOString();
const { data } = await admin.from("ticket_csat")
  .select("rating")
  .eq("workspace_id", workspaceId)
  .gte("submitted_at", since);
const avg = (data || []).reduce((s, r) => s + r.rating, 0) / (data?.length || 1);
```

### Response rate (CSATs submitted / sent)
```ts
const [{ count: submitted }, { count: sent }] = await Promise.all([
  admin.from("ticket_csat").select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId).gte("submitted_at", since),
  admin.from("tickets").select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId).gte("csat_sent_at", since).not("csat_sent_at", "is", null),
]);
const rate = sent ? submitted / sent : 0;
```

### Recent responses with ticket + customer joined
```ts
const { data } = await admin.from("ticket_csat")
  .select("rating, comment, submitted_at, tickets(subject), customers(first_name, email)")
  .eq("workspace_id", workspaceId)
  .order("submitted_at", { ascending: false }).limit(50);
```

## Gotchas

- **A ≤3 rating triggers a Cora deep review.** On the rate path, `POST /api/csat/[ticketId]` fires `analyzeTicket(ticketId, "low_csat")` when `rating <= 3` (best-effort, fire-and-forget). Because CSAT rows only exist for RESOLVED tickets, a ≤3 rating is "customer said resolved but rated us poorly" — an end-result miss the cheap triage pass never saw (it runs before the survey). The `low_csat` trigger bypasses the cheap pass and forces a deep grade, which then OVERRIDES the cheap pass's optimistic score on the ticket. See [[../libraries/ticket-analyzer]] § Cora dial-in.
- **One row per ticket.** UNIQUE(`ticket_id`) — re-submits update the existing row.
- **CSAT is gated.** The survey asks "did we resolve your issue?" FIRST. Customer answers "No" → ticket reopens via inbound `ticket_messages` row, gets tagged `csat:reopened`, and NO `ticket_csat` row is created. Only resolved-issue ratings land here. The dashboard infers reopen rate from the tag, not from this table.
- **Points are awarded once.** `points_awarded > 0` means we've already given them 500 points; re-submit doesn't double-pay.
- **Send marker lives on tickets.** `tickets.csat_sent_at` is set by the cron when the email goes out — used for response-rate calcs.
- **Cron is the trigger, not Inngest events.** `ticket-csat-cron` ([[../inngest/ticket-csat]]) runs every 15 min, finds closed tickets where `closed_at` is 48h-7d old AND `csat_sent_at IS NULL`, sends, stamps. Sleep-step pattern was replaced because long sleeps are fragile.
- **Eligibility window: 48h-7d.** Tickets closed >7d ago with `csat_sent_at IS NULL` get auto-stamped as skipped (prevents the migration-day backlog from triggering blast emails on tickets from months ago, which read as spam). A ticket that closes and reopens before 48h doesn't get a CSAT this cycle; if it closes again later, the same 48h-7d window applies.
- **Owner soft-exclude drops rows from the CS-quality stats.** `excluded_at IS NOT NULL` means the workspace OWNER flagged this CSAT as reflecting a product complaint, not service. The `/api/workspaces/:id/csat` GET filters excluded rows out of the count / avg / by_rating histogram / response-rate numerator, but the dashboard LIST still includes them (dimmed with an 'Excluded from stats' label + reason) so the owner can reverse via the CSAT dashboard's owner-only Exclude/Include control. Include/exclude actions are OWNER-only (admin/agent get 403). Reversible + audited via `excluded_by` + `exclusion_reason` — never a hard delete.
- **CSAT is only sent for tickets we actually answered.** The cron's eligibility guard skips (and stamps `csat_sent_at` on) any ticket with no customer-facing outbound message (`ticket_messages` has no `direction='outbound' AND visibility != 'internal'` row), `do_not_reply = true`, or a `SKIP_TAGS` tag (`outreach`/`cls:outreach`/`spam:bot`). OOF/auto-reply/spam/do_not_reply tickets the AI correctly ignored never get a "how did we do?" email — they were polluting the CSAT average with the auto-responder's 1-star. The `SKIP_TAGS` set lives in `src/lib/ticket-tags.ts`, shared with the ticket-analyzer.

## Related

[[../inngest/ticket-csat]] · [[../lifecycles/csat]] · [[tickets]] · [[loyalty_members]] · [[../README]]
