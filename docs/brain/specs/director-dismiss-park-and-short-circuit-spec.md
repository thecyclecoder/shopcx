# Ada can dismiss a stale park + short-circuit a no-longer-needed spec 🚧

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — extends the director's action surface so I can clear cleanly instead of leaving stale park rows or part-shipped specs sitting forever.

**Why now (2026-06-24):** the Amazing Creamer product-seed park. A real "we don't need this anymore" call the CEO made in chat, and I had no action for it. Parks sit in `agent_jobs` `needs_attention` until [[no-parked-specs-auto-route-needs-attention]] picks them up — but auto-route can't help here: there's no shipped target to fold to (the underlying spec [[box-product-seeding]] has 0 shipped phases) and no real_blocker to spec around (the blocker is "we changed our mind," not a code gap). The CEO had to manually tell me "we're done with this" and I still had no clean way to land that decision. This spec gives me the two actions to do it myself, with audit + reversibility instead of silent suppression.

## North star — actions with an audit trail, not a coaching rule that hides a class

The CEO's instinct was right: don't train me to suppress with a coaching rule when the real answer is an action you can SEE in `director_activity`. A dismiss/short-circuit row in the ledger is supervisable; a coaching rule that suppresses a class of parks is not.

## Phase 1 — `dismiss-park` director action ✅

A new `pending_action` shape the director emits when a parked `agent_jobs` row is genuinely not worth pursuing (the underlying work is being short-circuited, a prereq won't be supplied, the park is stale and not auto-routable).

- New `PendingAction` `{type:'dismiss-park', jobId:string, reason:string}` in [[../libraries/platform-director]]; required `reason` (no silent dismissals).
- Worker handler in `scripts/builder-worker.ts`: auto-applies on the same model as `spec-status` (audit is the gate, not per-flip CEO approval — reversible from the activity feed). The handler `UPDATE`s `agent_jobs SET status='dismissed', needs_attention_class='dismissed_by_director', completed_at=now() WHERE id=$jobId`, then writes a `dismissed_park` [[../tables/director_activity]] row carrying the reason + the original park's `needs_attention_class` + the underlying spec slug.
- `routeNeedsAttention` filters out `dismissed_by_director` so the auto-router never re-processes a dismissed row. The daily board watch appends a line — "dismissed N stale parks today" — so the CEO sees what I'm clearing without having to inspect the ledger.
- **Reversible — mirror [[director-supervised-repair-dismissal-surface-dismissal-reopen]]:** render dismissed parks in the activity feed with a one-tap **Re-open** (owner-gated, flips the job back to `needs_attention`, clears the dismissal marker, logs `reopened_park`).
- **Owner-only:** the job's underlying spec slug must resolve to a spec whose `Owner: [[../functions/{fn}]]` matches mine; a dismiss on someone else's job is rejected as out-of-leash and logged.
- **Leash:** `monitoring_fix` class (low-risk + reversible — a wrongly-dismissed park is one re-open click away).
- Brain: [[../libraries/platform-director]] · [[../tables/agent_jobs]] · [[../tables/director_activity]].

### Verification — Phase 1
- I emit `dismiss-park` on a `needs_attention` row I own → expect `status='dismissed'` + `needs_attention_class='dismissed_by_director'`, a `dismissed_park` `director_activity` row carrying my reason + `metadata.job_id` + `metadata.spec_slug`, and the row drops out of `routeNeedsAttention`'s candidate list on the next pass.
- The CEO clicks Re-open from the activity feed → `status='needs_attention'`, dismissal marker cleared, `reopened_park` row landed.
- I try to dismiss a parked job whose underlying spec is owned by a different function → rejected as out-of-leash, no DB write, logged for audit.
- I emit `dismiss-park` with no reason → rejected as a schema error.
- The board-watch post counts the day's dismissed parks alongside the existing rollup (squashed / escorted / escalated).

## Phase 2 — `spec-status` `shortCircuit` flag ✅

Today `spec-status` flips `planned|in_progress|shipped|rejected`. None fit "we changed our mind, this isn't needed anymore": `rejected` reads as "the spec was wrong" and `shipped` implies the phases actually built. Add a `shortCircuit:true` flag carried alongside `status:'shipped'` that means "closed cleanly without all phases shipped — work is no longer needed."

- Extend the `spec-status` shape in [[../libraries/platform-director]] to accept `{shortCircuit:true, reason:string}`. Reason is required when `shortCircuit:true` (no silent short-circuits). Schema validation rejects `shortCircuit:true` without `reason` and rejects `shortCircuit:true` with any `status` other than `'shipped'`.
- Worker handler: flip `spec_card_state.status='shipped'` via the existing `markSpecCardStatus` writer + write a `spec_status_history` row with `actor=director:{my-function}`, `reason=$reason`, and a `metadata.short_circuit=true` marker. SKIP the fold-build enqueue (there's nothing to fold — the brain pages weren't updated by this short-circuit; the spec + skill stay intact as reference).
- The [[../dashboard/roadmap]] card renders a short-circuited spec distinctly: shipped-styling with a "short-circuited — $reason" sub-line, so the next reader doesn't think we built it.
- **Reversible:** the CEO flips the spec back to `planned` from the existing roadmap owner UI, which clears the short-circuit marker via a `spec_status_history` row with `metadata.short_circuit_cleared=true`.
- **Owner-only:** same gate as the regular `spec-status` — only the spec's owning function director can short-circuit it.
- **Leash + auto-apply:** auto-applied like every other `spec-status` action (the audit row + reversibility are the gate, not a per-flip CEO card).
- Brain: [[../libraries/platform-director]] · [[../tables/spec_card_state]] · [[../tables/spec_status_history]] · [[brain-roadmap]].

### Verification — Phase 2
- I emit `spec-status` `{status:'shipped', shortCircuit:true, reason:'no longer needed — CEO 2026-06-24'}` on a spec I own → `spec_card_state.status='shipped'`, a `spec_status_history` row with the reason + `metadata.short_circuit=true` + `actor=director:platform`, and NO fold-build queued in `agent_jobs`.
- The roadmap renders that spec as shipped + short-circuited with the reason visible in the card.
- The CEO flips the spec back to `planned` from the roadmap → the short-circuit marker clears (`metadata.short_circuit_cleared=true` history row) and the spec returns to normal handling.
- `shortCircuit:true` with no `reason` → rejected as schema error.
- `shortCircuit:true` with `status:'rejected'` → rejected as schema error (short-circuit is shipped-only).
- `shortCircuit:true` on a spec owned by a different function → rejected as out-of-leash, no DB write.

## Phase 3 — apply both to the Amazing Creamer park ⏳

After Phase 1 + 2 land, run the two actions on the live state:

- `dismiss-park` on the Amazing Creamer product-seed `agent_jobs` row with reason "underlying spec short-circuited — CEO 2026-06-24, see box-product-seeding."
- `spec-status` on [[box-product-seeding]]: `{status:'shipped', shortCircuit:true, reason:'no longer needed — CEO 2026-06-24, retained as reference: seed-product skill + this spec + brain pages stay grep-able for future product seeding.'}`

### Verification — Phase 3
- The Amazing Creamer parked job drops out of `routeNeedsAttention`'s candidate list and is no longer surfaced to the CEO.
- [[box-product-seeding]] flips shipped + short-circuited on the roadmap with the reason visible.
- The `seed-product` skill, [[box-product-seeding]] spec, and product-seeding brain pages stay intact and grep-able — short-circuit only flips status, it does not delete or unindex.

## Verification

End-to-end checklist for the owner once Phase 1 + 2 are live in prod. Phase 3 (the Amazing-Creamer apply) is a runtime conversation the director runs once deployed.

- In a #cto-ada chat, ask Ada to dismiss a stale park she owns. She emits a `pending_actions:[{type:"dismiss-park", jobId, reason}]` and ACKS the dismiss in her reply → expect `agent_jobs.status='dismissed'` + `needs_attention_class='dismissed_by_director'` for that `jobId`, a `dismissed_park` row in `director_activity` carrying her reason + `metadata.job_id` + `metadata.spec_slug` + `metadata.prior_class`, and NO inbox/Slack approval card rendered for the action.
- Open `/dashboard/agents/platform` → expect the new `dismissed_park` row to appear in the activity feed with a "Re-open" button. Click Re-open → expect `agent_jobs.status='needs_attention'`, `needs_attention_class=null`, the button hidden on the next 30s tick, and a `reopened_park` row landed under the same `metadata.job_id`.
- In Slack, ask Ada to `dismiss-park` a parked job whose underlying spec is owned by a DIFFERENT function → expect no DB write to `agent_jobs`, no `dismissed_park` row, and an `invalid_dismiss_park_action` row stamped instead carrying the out-of-leash reason.
- POST a `dismiss-park` payload with no `reason` (via chat) → expect rejection logged as `invalid_dismiss_park_action` reason "reason is required (no silent dismissals)" and no `agent_jobs` write.
- Wait for the next daily platform watch post in `#directors` (or call `postPlatformWatchUpdate` ad-hoc) → expect the activity line to include `dismissed N stale parks` alongside the existing `squashed/escorted/escalated` rollup on a day she dismissed at least one.
- In a chat, ask Ada to `spec-status` flip a spec she owns with `{status:'shipped', shortCircuit:true, reason:'no longer needed — CEO 2026-06-24'}` → expect `spec_card_state.status='shipped'`, `spec_card_state.flags.short_circuit=true` + `flags.short_circuit_reason='no longer needed …'`, a `spec_status_history` row stamped `actor=director:platform`, and a `spec_status_flipped` `director_activity` row carrying `metadata.short_circuit=true`. NO fold-build queued in `agent_jobs` for the slug.
- Reload the `/dashboard/roadmap` board → expect the short-circuited spec to render in the Shipped column with the `short-circuited — <reason>` chip visible directly below the title.
- Emit `spec-status` with `{shortCircuit:true}` and no `reason` → expect rejection (`invalid_spec_status_action` row carrying "shortCircuit:true requires a reason"). Emit `{shortCircuit:true, status:'rejected'}` → expect rejection ("shortCircuit:true requires status:'shipped'").
- From the roadmap UI, flip the short-circuited spec's status back to `planned` → expect `flags.short_circuit` cleared (now false/absent), the chip removed on next render, and the spec returns to normal handling (build/escort/groom).
- Re-emit a `dismiss-park` on the SAME parked `jobId` after a Re-open → expect the dismiss to land normally (the row is `needs_attention` again, owner-leash passes), so the dismiss/re-open cycle is durable.
