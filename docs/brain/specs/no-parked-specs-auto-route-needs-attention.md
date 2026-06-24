# no-parked-specs-auto-route-needs-attention

**Owner:** [[../functions/platform]]
**Parent:** [[../functions/platform]] — operational mandate: every spec flows or escalates, never parks
**Status:** ⏳ Planned

## Why

needs_attention is currently a terminal state for the build worker — it punts, writes a reason, and waits for a human (Ada or the CEO) to pick it up. The CEO's rule: a spec is either building or being fixed via a new spec / new phase. Parking creates ghost work that looks done-ish in the queue but actually requires manual triage to move.

Real instances on 2026-06-24:

- `chat-fallback-absorbed-anthropic-overload-noise` — work shipped in PR #442, build agent walked into the repo, saw the code was already there, parked with verdict no unsatisfied phase remained.
- A security-review job parked twice in a row — security subagent timed out on stdin with no parseable verdict, escalated the raw log to the CEO as a no-op.
- Latent: any build that surfaces an unstated blocker would park the same way.

Two of those already have spot coachings (auto-fold when already shipped; spec-the-fix when security-review fails). This spec generalizes: `needs_attention` is a **classification gate**, not a resting state. Every park is auto-routed within minutes — fold, child spec, or invite-to-chat — never left to rot. Deferred is the only legitimate non-flowing state, and Deferred is a CEO choice, not a worker punt.

This is distinct from [[../specs/director-escalations-must-surface-to-ceo-backfill-swallowed]] (surfacing escalations the CEO never saw) — that ensures visibility; this ensures the work actually moves.

## Phases

### Phase 0 — classify the park reason

- Add `needs_attention_class` text column to `agent_jobs` (and mirror on `spec_card_state.last_park_class`): `already_shipped` | `real_blocker` | `tooling_failure` | `design_change` | `unknown`.
- The build worker stamps the class at park time. Heuristics from the existing `needs_attention_reason` string + a 1-shot Sonnet classifier with the build's verdict + the spec's phase list.
- Backfill existing `needs_attention` rows by re-running the classifier read-only against their stored reason text.

### Phase 1 — auto-fold when `already_shipped`

- Cron sweep (every 10 min) finds `needs_attention_class = 'already_shipped'` rows owned by Platform.
- Verifies the named PR is merged and the spec's described code/brain pages exist in `main`.
- Queues a `fold` job (uses the existing fold-to-brain skill), then flips the spec via the `spec-status` writer (status=shipped, phases marked shipped where appropriate), appends `spec_status_history` actor=director:platform.
- Codifies the coaching `auto-fold-when-build-returns-needs-attention-and-work-already-shipped` so the rule executes in code, not in director judgment.

### Phase 2 — auto-spec the blocker when `real_blocker` / `tooling_failure`

- Platform director picks up the park during its standing pass.
- Authors a child spec for the blocker (`{slug}-fix-{blocker}` or similar), owner=Platform, parent=the original spec, marks **Priority:** critical if the original was already critical or blocks shipped milestones.
- Flips the original spec phase back to `planned` with a **Blocked-by:** line pointing at the child spec.
- The original waits. The new spec builds. Nothing sits as parked.
- For `tooling_failure` specifically (the security-review-stdin-timeout pattern), the child spec targets the tooling fix, not the original phase's content.

### Phase 3 — invite the CEO to chat when `design_change`

- The only park class that legitimately surfaces to the CEO: a build revealed the spec's design is materially wrong, not a fixable bug.
- Reuses the [[../specs/ada-slack-routed-approvals]] chat invitation lane: a short `can we chat about this spec?` message in #cto-ada, opens a `director_coach_thread`. The conversation produces a spec-edit or a new spec; never a raw log dump or bare approve button.

### Phase 4 — backstop sweep + alarm

- A 60-minute sweep finds any `needs_attention` row older than 60 minutes that isn't routed yet (the classifier returned `unknown` or the routing job failed). Forces it through a manual director investigation pass with full context.
- Posts a `dashboard_notifications` row if any spec sits >70 minutes in `needs_attention` — the invariant alarm. Goal: that alarm fires zero times once Phase 4 ships.

## Verification

- A fresh park with `needs_attention_class='already_shipped'` flips the spec to `shipped` within ~15 min (Phase 1 cron + 1).
- A fresh park with `needs_attention_class='real_blocker'` produces a child spec within the next director pass, and the original spec gets a **Blocked-by:** line pointing at it.
- A fresh park with `needs_attention_class='design_change'` posts a `#cto-ada` chat invitation in a new thread, not a bare approval card or a log dump.
- `spec_card_state` rows in `needs_attention` for more than 70 minutes = 0 (alarm asserts this).
- The CEO never sees a raw build log again.

## Brain folds

- `docs/brain/libraries/platform-director.md` — document `needs_attention` as a transient classification gate, not a state.
- `docs/brain/tables/agent_jobs.md` — document the `needs_attention_class` column + values.
- `docs/brain/operational-rules.md` — add the rule: every spec flows or escalates; parking is a bug.
