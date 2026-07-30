import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "cancel-jobs-for-archived-specs-reads-db-fold-not-just-markdown",
    {
      title: "cancelJobsForArchivedSpecs must include DB-folded/deferred specs, not just the filesystem markdown archive — folding a spec in the DB should cancel its in-flight jobs",
      why: "cancelJobsForArchivedSpecs (the helper that kills build/spec-test jobs for archived specs) derives its archived set from listArchivedSlugs(), which reads a FILESYSTEM markdown archive directory (docs/brain archive *.md). But specs are now archived in the DATABASE by setting the status override to folded/deferred (setSpecStatus) — the markdown archive lags or no longer exists post-markdown-retire. So a spec folded in the DB keeps its stuck build/spec-test jobs running: today, folding the obsolete media-buyer-agent-test-mock-support-neq-filter spec did NOT cancel its stuck needs_approval build job (cancelJobsForArchivedSpecs returned 0) and it had to be cancelled by hand. This is the recurring DB-vs-markdown source-of-truth drift.",
      what: "Make cancelJobsForArchivedSpecs treat DB-folded/deferred specs as archived (union the DB-archived set with the markdown archive), so folding a spec in the DB cancels its in-flight build/spec-test jobs automatically.",
      summary: "In src/lib/agent-jobs.ts cancelJobsForArchivedSpecs, union listArchivedSlugs() (filesystem, src/lib/brain-roadmap.ts) with the set of spec slugs whose DB status override is folded or deferred (via the specs-table SDK / listSpecs), then cancel active build+spec-test jobs for that combined set.",
      owner: "platform",
      parent: '[[../functions/platform]] — "Autonomous build platform" mandate: a DB-folded spec must stop consuming the build pipeline; the job-cancel helper reading only the filesystem archive leaves DB-archived specs\' jobs stuck. See [[../libraries/agent-jobs]] and [[../libraries/specs-table]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Union DB-folded/deferred slugs into the archived set",
          why: "listArchivedSlugs reads only the filesystem markdown archive, so a DB fold/defer never reaches the job-cancel helper.",
          what: "Add the DB-archived spec slugs (status override folded/deferred) to the set cancelJobsForArchivedSpecs cancels jobs for.",
          body: "In src/lib/agent-jobs.ts cancelJobsForArchivedSpecs (~line 254): after `const archived = await listArchivedSlugs()`, also read the workspace's DB-archived specs — spec slugs whose stored status override is 'folded' or 'deferred' — via the specs-table SDK (listSpecs filtered to those statuses, per the no-raw-PM-SQL rule; do NOT hand-roll `.from('specs')`). Union the two slug sets (dedupe) and use the combined set in the existing `.in('spec_slug', archived)` job query. Keep the existing ACTIVE_STATUSES + kind IN ('build','spec-test') filter. This makes setSpecStatus(slug,'folded'|'deferred') cancel that spec's in-flight jobs on the next sweep. Add a unit/integration assertion that a DB-folded spec's active build job is included in the cancel set even when no markdown archive file exists. Update docs/brain/libraries/agent-jobs.md per CLAUDE.md.",
          verification: "- tsc clean\n- cancelJobsForArchivedSpecs unions DB-folded/deferred slugs via the specs SDK",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "cancelJobsForArchivedSpecs reads DB spec status (SDK), not only the markdown archive", kind: "auto", exec_kind: "grep", params: { pattern: "listSpecs", path: "src/lib/agent-jobs.ts", expect: "present" } },
            { position: 3, description: "no raw .from('specs') was hand-rolled in agent-jobs", kind: "auto", exec_kind: "grep", params: { pattern: "from(\"specs\")", path: "src/lib/agent-jobs.ts", expect: "absent" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#build" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
