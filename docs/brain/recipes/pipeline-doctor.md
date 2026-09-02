# Recipe: Pipeline Doctor (`pipeline-doctor`)

An INSTANT, read-only diagnosis of the whole spec pipeline — the derived status of every board spec, its jobs/gates, and **exactly what's stuck and WHY**. Run it FIRST every session instead of hand-writing ad-hoc probe scripts. Pure diagnosis: it NEVER writes (no status flips, no enqueues, no mutations of any kind).

It COMPOSES the canonical readers ([[../libraries/brain-roadmap]] `getRoadmap` → derived status; [[../libraries/agent-jobs]] readers; [[../libraries/spec-test-runs]] + [[../libraries/security-agent]] rollups; [[../libraries/build-lifecycle]] `deriveLifecycleStage`) so it can never DRIFT from the board — a raw SQL re-derivation would. The derived status is the source of truth.

- **SDK:** [[../libraries/pipeline-doctor]] — `diagnosePipeline(opts?)` → `PipelineDiagnosis`.
- **CLI:** `scripts/pipeline-status.ts`.

## Run it

```bash
# compact table of ONLY stuck / anomalous specs (stuck-first) + a one-line summary
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts

DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts --all          # + healthy specs
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts --slug <slug>   # deep-dive ONE spec
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts --since 6       # only count anomalies ≥6h old as stuck
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/pipeline-status.ts --json          # raw PipelineDiagnosis JSON
```

Default output: a `SEV / STATUS / AGE / SPEC / WHY → ACTION` table of stuck + awaiting-human specs, led by the one-liner `N specs · X stuck · Y healthy · Z awaiting-human [severity breakdown] · build lane A/8`, with the **stored-status-override** check called out (LOUD when violated, a quiet "0 violations" when clean). `--slug` is a deep dive: full phases (with build/merge/PR provenance), every job per kind (status + age + heartbeat-age + `log_tail`), the spec-test + security gates, and every detector result + the final verdict.

In code:

```ts
import { diagnosePipeline } from "@/lib/pipeline-doctor";
const diag = await diagnosePipeline();                          // default workspace, stuck-only-ish
const deep = await diagnosePipeline({ slug: "my-spec" });        // one-spec deep dive
const all  = await diagnosePipeline({ includeHealthy: true, sinceHours: 6 });
```

## What each detector means (the WHY)

Each anomaly is a named classifier (see `CLASSIFIERS` in [[../libraries/pipeline-doctor]]); the list is the extension point. A spec's primary `stuck` verdict is the highest-severity match. `deferred-parked` + `awaiting-human` are surfaced but NOT counted as "stuck" (deferred is a deliberate CEO park — the only legitimate non-flowing state; awaiting-human is a healthy pause needing a person). A **deferred** spec is never stuck regardless of any other signal it carries.

| Detector | Sev | Means | Source signals |
|---|---|---|---|
| **stored-status-override-violation** | CRITICAL | The RAW `specs.status` column holds a DERIVED value (planned/in_progress/in_testing/shipped/rejected) instead of an override-only value (in_review/deferred/folded) or NULL. The column is OVERRIDE-ONLY ([[../libraries/specs-table]] `specs-status-override-only`); a stored derived value PINS the card over its phase rollup — a bug. Surfaced loudly in its own section. | one targeted read of `specs.status` |
| **failed-gate** | HIGH | An unresolved FAILED gate: a security review SURFACED for the owner (routed real-vuln fix / needs-human), OR a spec-test that concluded `issues`/`error` or carries an unresolved auto-`fail` regression. The fold/promote gate stays red. | `getSecurityStateBySlug.surfaced`; latest [[../tables/spec_test_runs]] verdict + `specTestHasOpenRegression` |
| **zombie-session** | HIGH | A `building`/`claimed` job whose `last_heartbeat_at` is older than the reaper threshold (~20m, `REAP_STALE_MS`). The session is dead; the reaper should re-queue or escalate. | `agent_jobs.last_heartbeat_at` age vs 20m |
| **stuck-in-testing** | HIGH | `in_testing`, spec-test GREEN + security GREEN, all phases accumulated — but never promoted. Reports WHICH gate didn't fire: one-off → auto-merge to main (Gate A); goal-bound + not on goal branch → spec→goal-branch promotion (Gate B); on goal branch → goal's atomic main promotion (Gate C). | derived status + `isSpecTestGreenForBranch`-shaped signals + `onGoalBranch` + goal binding |
| **built-not-stamped** | HIGH | `in_progress` AND the latest build job is `completed`/`merged`, but NO phase carries a `build_sha`. The build ran yet `stampPhaseBuilt` never advanced any phase — so it can never reach accumulation-complete. | latest `build` job status + `spec_phases.build_sha` |
| **in-testing-needs-human** | MEDIUM | `in_testing` but the spec-test verdict is `needs_human` (advisory, not an auto-green machine pass) — the promote gate won't clear until a human resolves the check(s). | latest spec_test_runs verdict=`needs_human` |
| **awaiting-human** | MEDIUM | A build is `needs_approval`/`needs_input` — says WHO it's routed to (owner / CEO) + the question/reason. A healthy pause, not a stall (not counted as stuck). | `agent_jobs.status` + `questions`/`pending_actions` |
| **drift-suspect** | MEDIUM | A phase is marked `shipped` with NO PR/merge_sha provenance — shipped-without-provenance is a drift signal. | `spec_phases` shipped with null pr+merge_sha |
| **shipped-not-folded** | MEDIUM | The DERIVED rollup is `shipped` and the stored status is not `folded`, but the fold gate keeps refusing — specs sit shipped-but-unfolded for days. The `suggestedAction` carries the fold gate's OWN refusal reason (e.g., `"an OPEN PR still carries branch claude/build-…"`), so the board says WHY instead of a generic message. Does not fire on deliberately-parked (`deferred`) specs or while a fold/build/spec-test/goal-fold job is live. | `getFoldRefusalsBySlug` map; derived status + job activity age (>12h grace) |
| **not-claimed** | LOW/MED | `planned`, Vale-passed, unblocked, `auto_build` on, no active build — yet sitting. Notes build-pool occupancy so "stuck vs just-queued-behind-a-full-pool" is clear. | derived status + `vale_review_passed_at` + `blocked_by` + active-build count vs pool size (8) |
| **deferred-parked** | INFO | `deferred` — surfaces the audited defer reason + actor from [[../tables/spec_status_history]]. Not stuck (a CEO choice). | `specs.deferred` + history |

## Gotchas

- **Composes the canonical rollups — never re-derives status with raw SQL.** The ONE targeted raw read is `specs.status` (the override column the canonical readers deliberately never surface — required by the stored-status-override check) plus `milestone_id`/`deferred`; everything else comes through the SDK readers. This is what keeps the doctor from drifting from the board.
- **`spec-test` is a real runtime job kind** that the `JobKind` union doesn't list (enqueued by [[../libraries/agent-jobs]] `enqueueSpecTestIfDue`). The doctor types its job-kind set as strings to read it.
- **The default view hides deferred + healthy specs.** Use `--all` to see them; a deferred spec still shows its other detectors under `--slug`/`--all` but is always `not stuck`.
- **Read-only — it diagnoses, it does not fix.** Every `suggestedAction` names the helper/gate to run (e.g. `setSpecStatus(…, null)`, `autoMergeReadyPrs`, `stampPhaseBuilt`); the doctor never executes them.

## Related

[[../libraries/pipeline-doctor]] · [[../libraries/brain-roadmap]] · [[../libraries/agent-jobs]] · [[../libraries/spec-test-runs]] · [[../libraries/security-agent]] · [[../libraries/build-lifecycle]] · [[../libraries/specs-table]] · [[../lifecycles/spec-goal-branch-pm-flow]] · [[pm-flow-data-sources]] · [[../project-management]]

---

[[README]] · [[../README]] · [[../../CLAUDE]]
