# `src/lib/agents/director-leash-recommendations.ts` — grades → leash-adjustment recommendations

The **other half** of the director grading loop (M5 of [[../goals/devops-director]], [[../specs/director-loop-grading]] Phase 4). [[director-grader]] **writes** the grades ([[../tables/director_decision_grades]]); this **reads them back** and turns a *sustained* grade signal into an **owner-confirmed recommendation** to tighten/loosen the [[../specs/platform-director-agent|Platform/DevOps Director]]'s autonomy envelope ([[../tables/function_autonomy]] · [[approval-router]]).

One level **up the org chart** from the storefront campaign loop's `loadLeverGradeSignal` (there a sustained per-lever grade nudges the optimizer's lever selection); here a sustained per-dimension / per-leash-category grade **recommends** widening or narrowing the director's `live + autonomous` leash.

## The North-star invariant
This is a **supervised tool that only RECOMMENDS** ([[../operational-rules]] § supervisable autonomy; spec § Safety). It **never** writes `function_autonomy`, never widens the leash. **The CEO disposes** — the actual envelope change is the owner toggling **Autonomy** on the Agents hub (`POST /api/developer/agents/autonomy`). A recommendation is advisory text + the current envelope so the CEO can act; the loop can never promote itself.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `computeDirectorGradeReport` | `({ workspaceId, admin?, directorFunction? }) → Promise<DirectorGradeReport>` | The whole report for ONE director (default `platform`; `growth` is the Phase-2 addition): per-dimension + per-leash-category stats with a trend, the actionable recommendations, the recent grade rows, the proposed calibration rules, and the named director's envelope. Pure read; best-effort (a read failure degrades to an empty report). The grades are filtered by `director_decision_grades.director_function`. |
| `MIN_SAMPLE` `LOOSEN_AVG` `TIGHTEN_AVG` `OVERRIDE_GAP_RULE_THRESHOLD` | constants | The tuning: ≥3 graded calls before any recommendation; avg ≥8 → **loosen**; avg ≤4.5 → **tighten**; a human override moving the grade by ≥3 points proposes a calibration rule. |

## How it computes
- **rows** — the recent grades (newest-first, ≤500), each with a human-readable `target_label`. For an `auto-approval` row the **leash category** (`error_fix｜db_health｜additive_migration｜monitoring_fix`) is resolved best-effort by joining grade → [[../tables/approval_decisions]]`.agent_job_id` → [[../tables/agent_jobs]]`.pending_actions` → the approved action's `type` (two batched reads; an unresolvable row gets a null category).
- **dimensions** — per `auto-approval`／`goal-escort`: count, avg, and a **recent-vs-prior trend** (`up｜down｜flat`).
- **categories** — per leash category (auto-approval only): count + avg.
- **recommendations** — only the **actionable** ones (`loosen`／`tighten`; a "hold" scope is omitted). A scope needs `≥ MIN_SAMPLE` graded calls; `avg ≥ LOOSEN_AVG` (and not a declining trend) → loosen; `avg ≤ TIGHTEN_AVG` → tighten. Computed at **dimension** AND **leash-category** granularity.
- **autonomy** — the current Platform `{ live, autonomous }` from [[../tables/function_autonomy]] (via [[approval-router]] `loadAutonomyMap`), so the report shows **state vs. recommendation**.

## Where it's wired
- **Report** — `GET /api/developer/agents/grades` (owner-gated) returns `computeDirectorGradeReport`; rendered on the **Agents hub** Director-grades tab (CEO + Platform roles).
- **Override** — `POST /api/developer/agents/grades/{gradeId}` records `graded_by='human'` + `overridden_by`, and on a ≥`OVERRIDE_GAP_RULE_THRESHOLD` gap (or explicit request) drafts a `proposed` [[../tables/director_grader_prompts]] rule (Opus, [[ai-models]]).
- **Calibration review** — `PATCH /api/developer/agents/grader-prompts/{ruleId}` approves/rejects a proposed rule; only an `approved` rule reaches the grader ([[director-grader]] `buildDirectorGraderSystemPrompt`).

## Gotchas
- **Recommend-only** — no apply path. The dispositive write is the Autonomy toggle; this module has no access to it by design.
- **Category is best-effort** — if the join can't resolve a leash category, the row falls back to dimension-level only; the dimension recommendation alone satisfies the loop.
- **Computed on read** — no persistence of recommendations; they re-derive each load from the live grades, so an override/new grade changes them immediately.

---

[[../README]] · [[director-grader]] · [[../tables/director_decision_grades]] · [[../tables/director_grader_prompts]] · [[../tables/function_autonomy]] · [[approval-router]] · [[platform-director]] · [[../specs/director-loop-grading]] · [[../goals/devops-director]] · [[../../CLAUDE]]
