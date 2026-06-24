# Bounce escalation back to its director — CEO 'you handle this' affordance

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — extends the CEO's response surface on a director escalation so a sound diagnosis the director already produced can land without manual CEO work.
**Blocked-by:** [[director-judgment-lanes-fold-author-dismiss]]

When a director escalates (the lane's verdict surface can't represent the right next step), the escalation lands in the CEO inbox as a `dashboard_notifications` row whose only affordance is **Dismiss**. Even when the agent's diagnosis already names the correct two actions — e.g. fold this spec + author a parser-fix spec — the CEO has to perform them by hand. [[director-judgment-lanes-fold-author-dismiss]] adds the missing verdicts (`fold_now` / `author_followup_spec` / `dismiss_candidate`) to the director's lanes, but the existing escalation in the CEO inbox is stranded: it was decided before those verdicts existed, and there's no way to re-invoke the director with the richer surface short of waiting for the next cadence pass.

This spec adds a **Send back to {Director}** button on every CEO-routed escalation card. One tap re-queues the original lane (groom / init / repair-dismissal / approval) for the owning director with the original investigation context + an optional one-line CEO note. The director re-investigates with the FULL judgment-lanes verdict surface; if the diagnosis is correct, it lands the action this time instead of re-escalating. The original notification is dismissed; a `director_activity` row stamps the bounce + reason so the audit trail captures 'the CEO chose to let the director handle this.' Depth-capped at one round-trip so we never ping-pong.

## Phase 1 — bounce-back endpoint + payload
- New `POST /api/developer/agents/inbox/bounce-back` (owner-gated). Body: `{ notificationId, note? }`. Loads the notification, asserts it's an escalation (`type='agent_escalation'` or the routed-inbox escalation shape), reads `metadata.routed_from_function` (the director slug), `metadata.lane` (groom | init | repair-dismissal | approval), and the original `metadata.agent_job_id` + investigation context.
- Inserts a NEW `agent_jobs` row `kind=<original-lane-kind>` with `payload.bounced_back={ from_notification_id, ceo_note, original_escalation_reason, original_agent_job_id, depth }`, `status='queued'`, `owner_function=<director-slug>`. Dismisses the original notification (`dismissed=true`).
- Writes a `bounced_back_by_ceo` `director_activity` row carrying the lane, the original escalation reason, the CEO note, and the new job id.
- **Acyclic guard.** Each bounce-back stamps `payload.bounced_back.depth = (prior depth) + 1`. Phase 3 enforces the cap.

## Phase 2 — Send-back button on every CEO escalation card
- `ApprovalRow` in `src/app/dashboard/agents/page.tsx`: when the row is an escalation (`type='agent_escalation'` OR no `agent_job_id` + `metadata.routed_from_function` set), render a small **Send back to {Director}** button next to Dismiss. Click opens a tiny inline composer with an optional one-line note + Confirm. Confirm calls `/api/developer/agents/inbox/bounce-back`. On success the row disappears on the next inbox poll; a toast confirms 'Bounced back to {Director}.'
- The button is hidden when `metadata.routed_from_function` is missing (genuine CEO-only escalations — there's no director to bounce to).
- Hidden when `payload.bounced_back.depth >= 1` on the underlying job (already bounced once — one round-trip is the leash).

## Phase 3 — director-side: read `bounced_back` + use the richer verdicts
- Each lane's director investigation prompt (groom / init / repair-dismissal / approval) reads `payload.bounced_back` if present and prepends a one-line preamble: 'The CEO sent this back to you. Use the richer judgment-lanes verdicts to land a real action.' The verdict surface the director picks from is the FULL set from [[director-judgment-lanes-fold-author-dismiss]] — `fold_now` / `author_followup_spec` / `dismiss_candidate` in addition to the lane's native ones. The `ceo_note`, when present, is shown verbatim as context.
- **Depth cap.** A bounced-back investigation that STILL escalates is allowed exactly once (`depth=2` ceiling); on the second escalation the lane writes a `re_escalated_after_bounce` `director_activity` row + surfaces a fresh CEO escalation card carrying BOTH diagnoses (the original + the post-bounce) so the CEO can decide manually. No infinite ping-pong.

## Safety / invariants
- **One bounce, not infinite.** The depth counter caps the round-trip at one; the CEO is never the only mechanism unblocking a real stuck case, and a director that can't land an action after one richer-surface pass really does need the CEO.
- **No leash widening.** A bounce-back never lets a director do anything outside its existing leash — it just re-invokes the lane with the same restrictions. The CEO is granting 'spend more compute on this,' not 'do something destructive.'
- **Audit trail intact.** Every bounce writes a `bounced_back_by_ceo` `director_activity` row. Every re-escalation after a bounce writes its own. The notification itself is dismissed, not deleted.
- **Owner-gated.** Only the workspace owner can bounce (mirrors the existing dismiss endpoint's gate). A non-owner POST returns 403.
- **Dependency on judgment-lanes.** Without [[director-judgment-lanes-fold-author-dismiss]] shipped, a bounce is a no-op — the director re-investigates with the same narrow verdict surface and immediately re-escalates. Block on it.

## Completion criteria
- A CEO escalation card in `/dashboard/agents` shows a **Send back to {Director}** button when `metadata.routed_from_function` is set and depth < 1.
- Clicking it dismisses the original notification, queues a new `agent_jobs` row for the original director's lane carrying the investigation context + CEO note + depth counter, and writes a `bounced_back_by_ceo` activity row.
- The director re-investigates with the FULL judgment-lanes verdict surface and either lands an action (`fold_now` / `author_followup_spec` / `dismiss_candidate` / `continue` / `split`) or re-escalates exactly once.
- The depth cap prevents infinite bounce-backs: a second escalation after a bounce writes `re_escalated_after_bounce` and surfaces a fresh CEO card carrying both diagnoses.

## Verification

### Phase 1 — endpoint + payload
- `POST /api/developer/agents/inbox/bounce-back` as the owner with a valid escalation `notificationId` + a `note` → expect 200; the notification flips `dismissed=true`; a new `agent_jobs` row appears `kind=<original-kind>`, `status='queued'`, `owner_function=<director-slug>`, `payload.bounced_back.depth=1`, `payload.bounced_back.ceo_note=<note>`, `payload.bounced_back.original_escalation_reason=<original reason>`.
- A `director_activity` row `kind='bounced_back_by_ceo'` is written carrying the lane, original reason, CEO note, and new job id.
- As a non-owner → 403. With a `notificationId` that isn't an escalation → 400 (`'only escalations can be bounced'`).
- With a notification whose `metadata.routed_from_function` is missing → 400 (`'no director to bounce to'`).

### Phase 2 — Send-back button
- On `/dashboard/agents` as the CEO, with an active director escalation in the inbox → expect a **Send back to {Director}** button next to Dismiss. Click → inline composer with an optional one-line note + Confirm. Confirm → row disappears on next poll; toast 'Bounced back to {Director}.'
- An escalation with `payload.bounced_back.depth >= 1` on its underlying job → button is hidden (Dismiss only).
- An escalation with no `metadata.routed_from_function` (genuine CEO-only) → button is hidden.

### Phase 3 — director re-invocation + depth cap
- After Phase 2 ships, bounce a known-escalated grooming case (e.g. a spec that's truly fold-ready but the lane's verdict surface can't represent it) → the director's next invocation runs with the preamble + the richer verdict set; expect it to land a `fold_now` or `author_followup_spec` decision (verified via spec_status_history + a new spec authored, respectively) instead of re-escalating.
- A bounced-back investigation that emits `escalate` again → expect a `re_escalated_after_bounce` `director_activity` row AND a fresh CEO escalation card carrying BOTH diagnoses (`metadata.diagnoses[]` length 2). Bouncing this card again → 400 (`'depth cap reached'`).
- `npx tsc --noEmit` clean.