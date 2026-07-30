/**
 * Authors the root-fix spec: archived-spec job cleanup must also reap needs_attention jobs.
 * Owner=platform, parented to the Autonomous-build mandate. From the Ada-noise diagnosis:
 * cancelJobsForArchivedSpecs filters on ACTIVE_STATUSES, which OMITS 'needs_attention', so a
 * folded spec's parked build job is never reaped → Ada's stuck-detector re-flags shipped specs
 * every standing pass. Founder-directed 2026-07-15.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "reap-needs-attention-jobs-for-archived-specs";

const PARENT =
  '[[../functions/platform]] — "Autonomous build platform" mandate: the build board must reflect reality — a folded/shipped spec must not keep a parked build job that makes the pipeline look stuck. See [[../libraries/agent-jobs]] and [[../libraries/platform-director]].';

async function main() {
  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title: "Archived-spec job cleanup reaps needs_attention jobs (Ada stops flagging shipped specs as stuck)",
      summary:
        "**Brain refs:** [[../libraries/agent-jobs]] (`cancelJobsForArchivedSpecs` · `ACTIVE_STATUSES` · `filterJobsForArchivedSpecs`) · [[../libraries/platform-director]] (`platformHasPendingWork` stuck-build signal)\n\ncancelJobsForArchivedSpecs reaps a folded/deferred spec's build/spec-test jobs, but it filters on ACTIVE_STATUSES, which OMITS 'needs_attention'. So when a spec folds/ships with a parked needs_attention build job (e.g. an earlier build that parked, then a later build succeeded + folded the spec), that job is orphaned forever and Ada's 'builds stuck >90m' standing-pass signal re-flags the already-shipped spec every pass. Observed on director-sms-cockpit-per-director + claim-rpc-kill-switch-enforcement (both folded Jul-12, both re-flagged; reaped by hand). Extends the prior FS-vs-DB-folded cleanup fix, which still only reaped ACTIVE jobs.",
      owner: "platform",
      parent: PARENT,
      parent_kind: "mandate",
      parent_ref: "platform#build",
      blocked_by: [],
      priority: null,
      deferred: false,
      intended_status: "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: null,
      why:
        "A folded/shipped spec's parked needs_attention build job is never reaped because cancelJobsForArchivedSpecs (agent-jobs.ts:261) filters on ACTIVE_STATUSES (agent-jobs.ts:173), which excludes 'needs_attention'. The orphaned job then makes Ada's platform-director 'builds stuck >90m' signal (platform-director.ts:4790) re-surface an already-shipped spec every standing pass — recurring false-positive noise that hides real stuck builds. A needs_attention job whose spec is archived is definitively superseded and should be reaped.",
      what:
        "(1) In cancelJobsForArchivedSpecs, broaden the status filter so a job whose spec is FS/DB-archived is reaped even when its status is 'needs_attention' (the archived-spec membership is the authority; ACTIVE_STATUSES stays untouched for its other uses). Only jobs whose spec is folded/deferred/FS-archived are affected — live-spec needs_attention jobs are never touched. Backfill-safe: the next builder-worker sweep reaps existing zombies. (2) Defensive guard: the platform-director stuck-build signal (platformHasPendingWork + the standing-pass lister) excludes a job whose spec is already terminal (folded/shipped), so even a not-yet-reaped job in the window between fold and the next sweep can't surface a shipped spec as stuck.",
    },
    [
      {
        position: 1,
        title: "Phase 1 — reap needs_attention build/spec-test jobs for archived specs",
        status: "planned",
        body:
          "The root fix. A folded/deferred/FS-archived spec's job is superseded regardless of status, so the reaper must include needs_attention — not just ACTIVE_STATUSES. Gate stays the archived-spec membership; ACTIVE_STATUSES is left intact for its other callers.",
        why:
          "cancelJobsForArchivedSpecs queries `.in('status', ACTIVE_STATUSES)` (agent-jobs.ts:270) and ACTIVE_STATUSES omits 'needs_attention' (agent-jobs.ts:173), so a folded spec's parked build job is structurally uncatchable and lingers as Ada-noise forever.",
        what:
          "Change cancelJobsForArchivedSpecs to query build/spec-test jobs in ACTIVE_STATUSES ∪ {'needs_attention'} (a local REAPABLE set — do NOT mutate exported ACTIVE_STATUSES), then apply the existing filterJobsForArchivedSpecs gate + the same completed/superseded update. Add a unit test on filterJobsForArchivedSpecs / the query set proving a needs_attention job for a DB-folded spec is included in the reap set while a needs_attention job for a live spec is excluded.",
        verification:
          "vitest: a test that, given a needs_attention build job for a folded spec and one for a live (planned) spec, the reaper selects only the folded-spec job; and an integration-style test that cancelJobsForArchivedSpecs's status set contains 'needs_attention'. `npx vitest run` green, `npx tsc --noEmit` clean.",
      },
      {
        position: 2,
        title: "Phase 2 — stuck-build signal ignores jobs whose spec is already terminal",
        status: "planned",
        body:
          "Defensive belt-and-suspenders so a shipped spec can never be reported as stuck, even in the gap between a fold and the next reaper sweep.",
        why:
          "The platform-director stuck-build signal reads agent_jobs.needs_attention directly; between a spec folding and the next builder-worker reaper sweep, a parked job could still be surfaced. Joining spec status closes that window and makes the signal robust independent of reaper timing.",
        what:
          "In the platformHasPendingWork stuck-build signal (platform-director.ts:4790-4808) and the standing-pass stuck-build lister, exclude a needs_attention/building job whose spec status is terminal (folded/shipped) — resolve spec status via the specs-table SDK reader (never a raw .from('specs')). Add a test that a folded spec's parked job is NOT reported as a stuck build.",
        verification:
          "vitest: platformHasPendingWork / the stuck-build lister does not include a job whose spec is folded; a live-spec needs_attention job is still reported. `npx vitest run` green.",
      },
    ],
  );
  console.log("spec authored:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
