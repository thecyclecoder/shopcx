# libraries/support-mode

Software-mode support handoff — per-workspace live hours + honest escalation messaging. Owned by
[[../functions/cs]] as the DRI for the customer support path.

**File:** `src/lib/support-mode.ts`

## Why this exists

Decided by the CEO 2026-11-12 ("AI + live hours"): in a **software-mode** workspace the AI answers
everything, and the rare human handoff must be honest about WHEN a person will answer. Inside the
workspace's configured live hours the customer is told a person is joining the chat now and a live
owner gets a bell card; outside them (or when no hours are set) the customer is promised an email
reply within one business day and the ticket simply waits in the inbox. No empty-chat wait, no
false "someone is here" promise.

"Software mode" = a self-serve SaaS tenant workspace — **anything that is NOT the managed Superfoods
home workspace**, where June / the CS Director ([[cs-director]]) own escalations. There is exactly
one managed workspace in the system today, so the determination is "not the managed home workspace"
(`MANAGED_SUPPORT_WORKSPACE_ID`, the same id as `SUPERFOODS_WORKSPACE_ID` in
[[media-buyer-publish-identity]]).

## Exports

- `MANAGED_SUPPORT_WORKSPACE_ID` — the Superfoods home workspace (keeps June routing).
- `isSoftwareModeWorkspace(workspaceId): boolean` — true for every non-managed tenant.
- `type SupportLiveHours = { tz, days:number[], start:'HH:MM', end:'HH:MM' }` — the stored shape of
  [[../tables/workspaces]].`support_live_hours`.
- `isWithinLiveHours(cfg, now: Date): boolean` — the core predicate. null/invalid cfg → `false`
  (never live). Resolves the wall-clock weekday + HH:MM of `now` in the config's IANA `tz` (via
  `Intl.DateTimeFormat`), matches `days` (0=Sun … 6=Sat) and the `[start, end)` window. Supports
  overnight windows (`end` <= `start`, e.g. 22:00–02:00, which belong to their START day); a
  zero-length window (start === end) is never live. Unit-tested in `test:support-mode`
  (`src/lib/support-mode.test.ts`).
- `normalizeSupportLiveHours(raw): SupportLiveHours | null` — validate/clean a raw jsonb value
  (malformed → null). Used by the widget-settings PATCH so junk can never persist.
- `getSupportLiveHours(admin, workspaceId): Promise<SupportLiveHours | null>` — load + normalize.
- `softwareHandoffReply(live): string` — the honest customer-facing reply for the time of day.
- `routeSoftwareModeEscalation({ admin, workspaceId, ticketId, reason, now? })` — send the honest
  reply to the widget (external outbound AI `ticket_messages` row) and, inside live hours only,
  raise a `dashboard_notifications` card (`type='system'`, `metadata.kind='software_mode_live_handoff'`)
  so a live owner can pick it up now. Returns `{ live, message }`.

## Callers

- **[[action-executor]] `escalateTicket`** — after the authoritative escalation write, for a
  software-mode workspace it calls `routeSoftwareModeEscalation` and sets
  `ctx._softwareHandoffMessageSent` so `handleEscalate` skips its generic holding line (one coherent
  reply, not two). Best-effort — a failure never blocks the escalation.
- **[[../inngest/triage-escalations]]** — the hourly June-review enqueue filters out software-mode
  workspaces (`!isSoftwareModeWorkspace`), so a software tenant's escalations never route to June /
  the CS Director; the live-hours handoff is their whole escalation experience.
- **widget settings** — `src/app/api/workspaces/[id]/widget-settings` (GET/PATCH) +
  `src/app/dashboard/settings/chat-widget/page.tsx` read/write `support_live_hours`.

## Gotchas

- **null = never live.** An unconfigured workspace always shows the email promise — the seeded
  value for ShopGrowth until the CEO sets hours. Invalid tz / malformed HH:MM also fail closed to
  not-live (never throws).
- **Managed home workspace is excluded on purpose.** Changing `MANAGED_SUPPORT_WORKSPACE_ID` or
  adding a second managed workspace is a product decision — both the June triage gate and the
  escalate-path handoff key off `isSoftwareModeWorkspace`.
