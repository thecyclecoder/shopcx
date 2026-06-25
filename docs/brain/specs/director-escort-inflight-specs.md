# Director escort — drive in-flight + authored-fix specs through to ship ✅

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — closes the gap where the director authors a fix-spec, queues a build, and forgets to follow up. Specs sit `in_progress` for hours when a minimal escort would have shipped them. Authored from context to match the existing `spec_card_state` row (the markdown step never ran the first time).
**Blocked-by:** —

A director's existing standing pass investigates parks, grooms new specs, lifts gated builds, etc. — but it does NOT actively drive **specs the director itself authored** through to ship. The result is a class of stalls only the director can fix: a build that errored out, a spec stuck `in_progress` with no `agent_jobs` row in flight, a critical spec the CEO marked but no one rebuilt. This spec adds an explicit escort pass at the START of every standing run.

## Phase 1 — sweep + drive in-flight + authored-fix specs ✅
- New step at the START of every standing pass (before grooming + classifier): `escortSweep()` in `src/lib/agents/platform-director.ts`.
- Pull every `spec_card_state` row in this director's owner scope where `status='in_progress'` OR (`status='planned'` AND `flags.critical=true`) OR the spec was authored by this director within the last 7 days (`director_activity` `*_authored_spec` / `authored_fix` rows — the actual author-by-director kinds).
- For each: look up the latest `agent_jobs` row for `spec_slug={slug}` `kind='build'`. Five lanes:
  1. No build job ever → enqueue a build + log `escort_queued_build`.
  2. Build job `status='completed'`/`merged` but spec still planned/in_progress → log `escort_status_drift` + flip phases via `markSpecCardStatus(actor='director:platform')` for owner-scoped slugs; non-owned slugs escalate to the CEO.
  3. Build job `status='failed'` 1× → enqueue a retry.
  4. Build job `status='failed'` ≥2× → escalate to the CEO (deeper issue — the groom lane handles re-investigation on its own when the spec has ≥1 shipped phase).
  5. Build job in an active status (`queued`/`claimed`/`building`/`queued_resume`/`needs_input`/`needs_approval`) for >2h with no `last_merge_sha` → mark `escort_stalled` + escalate so the owner can investigate (parked? missing dep? branch-stuck?).
- Every action stamps a `director_activity` row `kind='escorted'` with `metadata.lane` + `metadata.source` (in_progress · critical · authored) + a one-line reason.
- Loop-guard: if `escortSweep` ran the SAME (slug, lane) ≥3× in 24h, escalate instead of re-acting (prevents an infinite re-enqueue on a build that always fails the same way). The loop-guard escalation also stamps a `kind='escorted'` row with `metadata.lane='loop_guard'`.

## Verification
- On the build box, watch one `runPlatformDirectorStandingPass` tick (`/dashboard/branches` → "platform director job" log lines) → expect `escort-sweep → …` lines in the standing-pass recap (`escort-sweep: N scanned, all healthy` when the queue is clean).
- In Supabase: insert a `spec_card_state` row with `status='in_progress'` for a slug that has **no** `agent_jobs` build row → after the next standing pass, expect one `agent_jobs` `kind='build'` `status='queued'` row inserted with `created_by=null` and `instructions` mentioning `escort-sweep, lane=queued_build`, plus a `director_activity` row with `action_kind='escorted'`, `director_function='platform'`, `metadata.lane='queued_build'`, `metadata.source='in_progress'`.
- In Supabase: insert three `director_activity` `action_kind='escorted'` rows for the SAME slug + same `metadata.lane='queued_build'` within the last 24h → on the next pass, expect a CEO notification with `dedupe_key='escort-loopguard:{slug}:queued_build'` + a `director_activity` row with `metadata.lane='loop_guard'` and `metadata.original_lane='queued_build'`.
- In Supabase: insert a `spec_card_state` row `status='planned'` for an owner-scoped slug whose latest build agent_jobs row is `status='merged'` → on the next pass, expect `spec_card_state.status='shipped'` + a `spec_status_history` row with `actor='director:platform'`, `from_value='"planned"'`, `to_value='"shipped"'`, `reason` starting `escort:status_drift`.
- In Supabase: insert a `spec_card_state` row `status='planned'`, `flags.critical=true` for an owner-scoped slug with no build row → expect the same `queued_build` lane action as the in-progress case (the critical filter pulls planned specs into scope).
- `npx tsc --noEmit` clean.
