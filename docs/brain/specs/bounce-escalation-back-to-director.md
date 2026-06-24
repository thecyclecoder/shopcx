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
- On `POST /api/developer/agents/inbox/bounce-back` as the workspace owner with a valid CEO-inbox escalation `notificationId` + a `note` → expect HTTP 200 `{ok:true, jobId, lane, director}`; the `dashboard_notifications` row flips `dismissed=true`; a new `agent_jobs` row appears `kind='director-bounce-back'`, `status='queued'`, `spec_slug=<candidate slug or signature>`, with `instructions` parseable as JSON `BounceBackInstructions{lane, director_slug, candidate_slug, candidate_job_id, candidate_signature, notification_id, ceo_note, original_escalation_reason, original_escalation_kind, original_dedupe_key, depth:1}`.
- On the same call → expect one `director_activity` row `action_kind='bounced_back_by_ceo'`, `director_function=<director-slug>` carrying `metadata.lane`, `metadata.original_notification_id`, `metadata.original_escalation_reason`, `metadata.ceo_note`, `metadata.new_job_id`, `metadata.depth=1`.
- On the same call as a non-owner → expect HTTP 403 `'Only the workspace owner can bounce escalations'`. With an unknown id → 404. With a notification whose `type !== 'agent_approval_request'` → 400 `'only escalations can be bounced'`. With one whose `metadata.escalated_by_director` is missing → 400 `'no director to bounce to'`. With one whose lane can't be derived (no escalation_kind, no agent_job_id) → 400 `'only escalations can be bounced'`. With `metadata.bounced_back_depth >= 1` → 400 `'depth cap reached'`.

### Phase 2 — Send-back button
- On `/dashboard/agents?view=inbox&role=ceo` as the workspace owner, with an active director escalation in the CEO inbox (a `dashboard_notifications` row with `type='agent_approval_request'`, `metadata.escalated_by_director='platform'`, `metadata.routed_to_function='ceo'`) → expect a **Send back to Platform** button rendered next to Dismiss in the row's footer.
- On clicking **Send back to Platform** → expect an inline amber composer with an optional 500-char textarea + **Confirm send-back** + **Cancel**. Confirm → POSTs to `/api/developer/agents/inbox/bounce-back`; on 200 the row disappears on the next inbox poll.
- On a notification whose `metadata.bounced_back_depth >= 1` (a re-escalation card from the depth cap) → expect the Send-back button HIDDEN (Dismiss only).
- On a notification with no `metadata.escalated_by_director` (a genuine CEO-only escalation) → expect the Send-back button HIDDEN.
- On the inbox API (`GET /api/developer/agents/inbox?role=ceo`) → each `agent_approval_request` item carries `escalatedBy`, `bounceLane`, `bouncedBackDepth` so the UI doesn't have to re-derive them.

### Phase 3 — director re-invocation + depth cap
- After Phase 1 + 2 ship, on a known-escalated grooming case (a spec that's truly fold-ready but the original verdict surface couldn't represent it) tap **Send back to Platform** → the box's `platform-director` lane claims the queued `director-bounce-back` job (concurrency-1 with the standing pass, so it never races); the worker runs `groomInvestigationPrompt(candidate)` prefixed with the `bounceBackPreamble(ctx)` (the preamble echoes the prior diagnosis + the CEO note); expect the verdict to land `fold_now` or `author_followup_spec` — verified via a new `spec_status_history` row + a `groomed_fold_now` `director_activity` row (or a `groomed_authored_spec` row + the new spec file on `main`).
- On a bounced-back investigation that re-emits `escalate` (or returns no recognizable verdict) → expect one `director_activity` row `action_kind='re_escalated_after_bounce'` carrying `metadata.lane`, `metadata.depth=2`, `metadata.original_notification_id`, `metadata.bounce_job_id` AND a fresh CEO `dashboard_notifications` row `type='agent_approval_request'` with `metadata.bounced_back_depth=2` + `metadata.diagnoses` (length 2: stages `original` + `post_bounce`). Bouncing THIS new card again via the endpoint → 400 `'depth cap reached'`.
- On the same flow for the init / repair-dismissal / approval lanes → the worker dispatches the verdict via the matching helpers (`applyDirectorFoldNow` · `applyDirectorAuthorFollowup` · `applyDirectorDismissCandidate` · `applyDirectorDismissal` · `applyDirectorApproval`) or enqueues a `kind='build'` for `continue` / `initiate`.
- On a bounce-back whose new agent_job dies mid-run (worker restart) → it lands back in the queued pool (`director-bounce-back` is in `RERUNNABLE_KINDS`) and re-claims cleanly.
- `npx tsc --noEmit` clean.