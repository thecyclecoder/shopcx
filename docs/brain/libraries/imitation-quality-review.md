# `src/lib/ads/imitation-quality-review.ts` — Max's per-sweep imitation-quality review

Phase 3 of [[../specs/flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded]]. Deterministic-Node applier + enqueue chokepoint for the Max box-session that reviews each scout sweep's newly-ingested competitor ads and auto-flags the OBVIOUS junk as `do_not_use` so Dahlia only imitates strong bases. Never runs an LLM itself — the box session in [[../../../scripts/builder-worker.ts]] `runImitationQualityReviewJob` is the sole LLM caller; this module owns the persist path from Max's verdicts.

## Why this exists

Winner-tier + days-running can't distinguish a lame Magic Mind display-box packshot from an Onnit "Lock in when it matters most" hero — both were proven long-runners of similar tenure, only one worth imitating. Phase 2 gave the CEO a manual `do_not_use` toggle on [[../dashboard/research__ads]]; Phase 3 (this module) is Max auto-flagging the OBVIOUS junk on every sweep so the CEO's review queue stays small and Dahlia's shelf stays clean at scale. Max's judgment is few-shot-anchored on the CEO's existing manual flags — the CEO owns the objective, Max learns the pattern under that oversight (north-star supervisable autonomy — [[../../CLAUDE.md]] § North star).

## Exports

| Export | Notes |
|---|---|
| `enqueueImitationQualityReview({workspaceId, skeletonIds})` | Inserts ONE `agent_jobs` row with `spec_slug='flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded'` + `kind='imitation-quality-review'` + `instructions={skeletonIds:[…]}`. No-op on an empty `skeletonIds` (a sweep that ingested nothing new has nothing for Max to review). Called by [[../inngest/creative-scout]] `sweepWorkspace` at the end of each workspace's sweep (query filter: `status='analyzed' AND media_type='static' AND created_at >= sweepStartIso`). |
| `applyBoxImitationQualityReview({workspaceId, jobId, requestedSkeletonIds, verdicts})` | Iterates Max's per-ad verdicts; calls the sole [[creative-skeleton]] `setSkeletonDoNotUse` chokepoint with `reason='max_weak_imitation_base'`, `by='max'` for every `not_usable` verdict; drops any verdict whose `skeleton_id` isn't in `requestedSkeletonIds` (defense-in-depth — never let an LLM vote on a row we didn't send it); returns `{flagged, kept, skipped, notFound, notificationInserted}`. Inserts ONE `dashboard_notifications` review card per sweep (deduped per `job_id`) summarizing what was flagged so the CEO can confirm/override. |
| `IMITATION_QUALITY_REVIEW_KIND` / `IMITATION_QUALITY_FLAG_REASON` / `IMITATION_QUALITY_FLAG_BY` | The canonical string constants — the agent-kind (`'imitation-quality-review'`), the flag reason (`'max_weak_imitation_base'`), and the flag actor (`'max'`). |
| `ImitationQualityVerdict` / `ImitationQualityCandidate` / `ImitationQualityBoxVerdict` / `ImitationQualityApplied` | Types. |

## The bar is DELIBERATELY coarse

Max flags ONLY the obvious junk:

- **auto-generated Shopify product/packshot ad** (a rendered PDP with no marketing thought)
- **bland packshot that conveys no powerful message** (no hook, no benefit callouts, no story)

and KEEPS anything with a real hook / benefit callouts / dynamic composition. Reason: a false NEGATIVE (a weak base slips through) is a minor downstream Dahlia miss; a false POSITIVE (a strong base wrongly killed) permanently narrows the imitation shelf. When in doubt → `usable`. The CEO's manual `do_not_use=true` flags are few-shot exemplars in the prompt (via [[../../../scripts/builder-worker.ts]] `runImitationQualityReviewJob`) — Max learns Dylan's taste; Dylan stays the objective owner.

## Guards + invariants

- `applyBoxImitationQualityReview` re-asserts `requestedSkeletonIds` at write time (Coaching #11/#12): a verdict whose `skeleton_id` isn't in the requested batch is skipped, not silently accepted. The compare-and-set on `(workspace_id, id)` lives inside [[creative-skeleton]] `setSkeletonDoNotUse` — a stale/cross-workspace row cannot be flipped from here.
- The applier NEVER touches `do_not_use` directly — it always goes through `setSkeletonDoNotUse`. Same rule as the Phase-2 PATCH handler: one chokepoint on the audit columns.
- The CEO review card is deduped per `job_id` (`metadata.dedupe_key = 'imitation_quality_review:<jobId>'`) so a worker retry doesn't spam the inbox. No card is inserted when Max flagged nothing (nothing to review).

## Node-completeness trio (CLAUDE.md hard rule)

- **OWNER** — `imitation-quality-review` is registered under `growth` in [[control-tower-node-registry]] `KIND_OWNER_FALLBACK` (Max, under the ad-creative line). The persona alias in `src/lib/agents/personas.ts` `KIND_PERSONA_ALIAS` maps `imitation-quality-review → growth` so the box card renders Max's face.
- **KILL-SWITCH ANCESTRY** — inherits Growth's ancestry via [[control-tower-node-registry]] `parentIdForOwner('growth')` → `director:growth`. A `dept:growth` / `director:growth` row in [[../tables/kill_switches]] cascades to this lane (fail-open: absent row ⇒ ON).
- **HEARTBEAT** — `runImitationQualityReviewJob` emits `emitAgentHeartbeat('imitation-quality-review', {ok, detail, durationMs})` from an end-of-run `try/finally` so a throw still beats `ok:false`.

## Callers

- [[../inngest/creative-scout]] `sweepWorkspace` — post-sweep enqueue (`enqueueImitationQualityReview`).
- [[../../../scripts/builder-worker.ts]] `runImitationQualityReviewJob` — the box-session runner (calls `applyBoxImitationQualityReview`).
- The `.claude/skills/imitation-quality-review/SKILL.md` is Max's persona/schema for the box session.

## Related

[[../specs/flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded]] · [[creative-skeleton]] · [[creative-sourcing]] · [[../tables/creative_skeletons]] · [[../inngest/creative-scout]] · [[../functions/growth]] · [[../dashboard/research__ads]]
