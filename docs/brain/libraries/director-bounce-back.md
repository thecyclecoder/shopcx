# libraries/director-bounce-back

The **CEO 'you handle this' affordance** for a stranded director escalation ([[../specs/bounce-escalation-back-to-director]]). When a director escalates a sound diagnosis the CEO inbox can render only **Dismiss** for, this module is the tiny shared layer behind sending it BACK to the director with the richer judgment-lanes verdict surface ([[../specs/director-judgment-lanes-fold-author-dismiss]]).

**File:** `src/lib/agents/director-bounce-back.ts`

## Why this exists

A director escalation lands in the CEO inbox as a `dashboard_notifications` row whose only affordance is **Dismiss**. Even when the agent's diagnosis already names the correct two actions (e.g. fold this spec + author a parser-fix spec), the CEO has to perform them by hand. The richer verdicts (`fold_now` / `author_followup_spec` / `dismiss_candidate`) added by [[../specs/director-judgment-lanes-fold-author-dismiss]] don't help an *already-decided* escalation — the lane returned its old verdict surface and the diagnosis is stranded.

This library defines the carried context (`BounceBackInstructions`) the endpoint stamps on the new `agent_jobs(kind='director-bounce-back')` row, the lane derivation (`laneForBounceBack`) the endpoint + the inbox API agree on, and the preamble (`bounceBackPreamble`) the worker prepends to the lane's investigation prompt. Depth-capped at one round-trip ([[../specs/bounce-escalation-back-to-director]] § Safety).

## Exports

| Symbol | What |
|---|---|
| `laneForBounceBack(meta)` | derive the originating lane from a CEO-routed escalation notification's `metadata` — maps `escalation_kind` (`groom_*` → `groom`, `init-*` / `initguard` → `init`, `repair_*` / `external_blocker` → `repair-dismissal`) and falls back to `approval` for an [[approval-inbox|Approval Request]] escalation (no `escalation_kind`, but `agent_job_id` + `escalated_by_director` set). Returns null when the notification isn't a director escalation we can bounce. |
| `BounceBackInstructions` | the typed payload the `director-bounce-back` agent_job carries in `instructions` (JSON-encoded). Holds the lane, the director slug, the candidate (slug / job-id / signature, depending on lane), the original diagnosis + escalation kind + dedupe key (for the re-escalation card), the CEO's optional one-line note, and the depth counter. |
| `bounceBackPreamble(ctx)` | the one-line preamble the worker prepends to the lane's investigation prompt — explains "the CEO sent this back, use the richer verdicts to land a real action," echoes the original diagnosis, and shows the CEO note verbatim. |
| `reEscalateAfterBounceBody(args)` | the body for the post-bounce CEO escalation card (depth cap) — surfaces BOTH diagnoses (original + post-bounce) so the CEO can decide manually. |
| `BOUNCE_BACK_JOB_KIND` | the stable `'director-bounce-back'` `agent_jobs.kind` literal. |

## Lane mapping

| originating `escalation_kind` | lane |
|---|---|
| `groom_unsure`, `groom_loop_guard`, `groom_split_invalid`, `groom_fold_now_invalid`, `groom_author_followup_invalid`, `groom_dismiss_invalid` | `groom` |
| `init-unsure`, `initguard`, `init_loop_guard`, `init_author_followup_invalid`, `init_dismiss_invalid` | `init` |
| `repair_dismissal_suspect`, `external_blocker` | `repair-dismissal` |
| *(none — `escalateApprovalRequestToCeo` doesn't set one)* + `agent_job_id` present | `approval` |

## Depth cap

One round-trip, by design:

- **First bounce** (CEO taps Send-back): endpoint enqueues a job with `depth=1` + dismisses the original notification + writes a `bounced_back_by_ceo` [[../tables/director_activity]] row.
- **Worker re-investigation**: runs the lane's prompt with the preamble and either lands an action OR re-escalates.
- **Re-escalation** (post-bounce verdict was still `escalate`): the worker writes a `re_escalated_after_bounce` [[../tables/director_activity]] row AND emits a fresh CEO card carrying `metadata.bounced_back_depth=2` + `metadata.diagnoses=[original, post-bounce]`. The UI hides Send-back; the endpoint refuses any further bounce with `400 'depth cap reached'`.

The audit trail is intact: every bounce writes one `bounced_back_by_ceo` activity row, every re-escalation writes its own, and both notifications are preserved (the original is `dismissed=true`, never deleted).

## Related

- [[../specs/bounce-escalation-back-to-director]] — the spec that introduces this affordance
- [[../specs/director-judgment-lanes-fold-author-dismiss]] — the richer verdict surface a bounced-back investigation uses
- [[platform-director]] — the director the bounce sends back to (today: always Platform; the only live director)
- [[approval-inbox]] · [[approval-router]] · [[director-activity]]
- [[../tables/dashboard_notifications]] · [[../tables/agent_jobs]] (the `director-bounce-back` kind)
- [[../dashboard/agents]] — the inbox surface that renders the Send-back button
