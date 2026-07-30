import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "ship-time-data-backfills-run-and-ledgered-not-silently-dead-code",
    {
      title: "A spec's one-time data backfill must run (and be tracked) on ship — a `_backfill-*` script that merges but never executes is a silent gap",
      why: "Twice now a spec that shipped a one-time data backfill left the data unfixed because the backfill was authored as an untracked scripts/_backfill-*.ts that merged into main but was never executed against prod. Migrations auto-apply on ship (applyMergedMigrations), but a TS backfill script does not — it lands as dead code. The media-buyer cohort-template spec shipped its guard + escalate phases, yet Superfood Tabs stayed blocked at 2/4 for days because its Phase-1 backfill never ran (the founder had to authorize a manual hotfix). The migration-ledger drift was the same shape. There is no detector, no ledger, and no escalation for an un-run ship-time data-op, so it silently rots — the opposite of supervisable autonomy.",
      what: "Detect a shipped spec's one-time data backfill in the post-merge hook, record it in a ledger, ESCALATE any un-run/failed one so it can never silently rot, and (gated) auto-execute idempotent backfills on ship the same way migrations auto-apply.",
      summary: "Mirror the migration path (applyMergedMigrations, called from applyMergedBuildEffects in src/lib/agent-jobs.ts:2933): add a data_op_runs ledger + a post-merge step that detects scripts/_backfill-*.ts added by the merged build's diff, escalates any with no successful ledger row (Phase 1), then runs idempotent ones once via tsx and records/gates them with a Control Tower tile (Phase 2).",
      owner: "platform",
      parent: '[[../functions/platform]] — "Autonomous build platform" mandate: a shipped data-op that silently never executes is a build-platform correctness hole; ship-time backfills need the same run+ledger+escalate rigor migrations already have. See [[../libraries/agent-jobs]] and [[../libraries/control-tower]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Ledger + detect + ESCALATE an un-run ship-time backfill (safety net first)",
          why: "The highest-value, lowest-risk piece: make an un-run backfill VISIBLE. Both past incidents were invisible until someone noticed the data was still wrong.",
          what: "Add a data_op_runs ledger and a post-merge detector that escalates any backfill script the spec shipped but that has no successful ledger row.",
          body: "Add migration supabase/migrations/20261021130000_data_op_runs_ledger.sql creating public.data_op_runs (id uuid pk default gen_random_uuid(), workspace_id uuid, spec_slug text, script_path text, status text check (status in ('pending','ran','failed')), ran_at timestamptz, error text, created_at timestamptz default now(), unique (workspace_id, spec_slug, script_path)) with RLS enabled (service-role only, matching the 294 other tables). In src/lib/agent-jobs.ts applyMergedBuildEffects (~line 2933, the post-merge hook), add a step: from the merged build's diff (the same diff source the phase-provenance stamping already uses), collect added files matching `scripts/_backfill-*.ts`; for each, if there is no data_op_runs row with status='ran', upsert a 'pending' row AND emit a director/CEO escalation (reuse the existing escalation path — the same one media-buyer under-provisioned cohorts use) naming the spec + script so it lands in the CEO inbox. NEVER auto-pass. Node-completeness trio (north-star hard rule): give the new detector an OWNER in the node registry, a kill_switches ancestry, and a heartbeat via emitReactiveHeartbeat/emitLoopHeartbeat. Add docs/brain/tables/data_op_runs.md + update docs/brain/libraries/agent-jobs.md per CLAUDE.md.",
          verification: "- tsc clean\n- the data_op_runs ledger migration exists\n- applyMergedBuildEffects detects + escalates un-run backfills",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the data_op_runs ledger migration exists", kind: "auto", exec_kind: "grep", params: { pattern: "data_op_runs", path: "supabase/migrations/20261021130000_data_op_runs_ledger.sql", expect: "present" } },
            { position: 3, description: "the post-merge hook detects ship-time backfills", kind: "auto", exec_kind: "grep", params: { pattern: "_backfill-", path: "src/lib/agent-jobs.ts", expect: "present" } },
            { position: 4, description: "an un-run backfill is escalated, not silently passed", kind: "auto", exec_kind: "grep", params: { pattern: "data_op_runs", path: "src/lib/agent-jobs.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Gated auto-execute of idempotent ship-time backfills + Control Tower tile",
          why: "Escalation makes it visible; auto-execution closes the loop so an idempotent backfill actually runs on ship without a manual hotfix.",
          what: "Run each pending _backfill script once via tsx, record 'ran'/'failed', and surface pending/failed data-ops on a Control Tower tile.",
          body: "Extend the Phase-1 detector: for each 'pending' data_op_runs row whose script matches the bounded convention (scripts/_backfill-*.ts, added by THIS spec's merge diff — never an arbitrary existing script), execute it once on the box via tsx (SUPABASE_DB_PASSWORD is present there, same env applyMergedMigrations uses), capturing exit code + stderr. On exit 0 → set status='ran', ran_at=now(). On non-zero/throw → status='failed', error=stderr, and ESCALATE (do not silently drop). Backfills are idempotent by convention (safe to re-run), so a duplicate execution is harmless. Add a Control Tower detector + output assertion that flips a tile RED while any data_op_runs row is 'pending' or 'failed' (mirrors the migration-drift tile) so an un-run/failed backfill stays visible until resolved; reuse the freshness + owner-scoping shape from the migration-drift check ([[../libraries/control-tower/migration-drift]]). Add a CLAUDE.md convention line: a one-time data backfill ships as an idempotent scripts/_backfill-*.ts (auto-run + ledgered on ship) OR an idempotent SQL migration — never an untracked script that only a human can remember to run. Update docs/brain/libraries/control-tower.md per CLAUDE.md.",
          verification: "- tsc clean\n- the executor runs + records pending backfills\n- a Control Tower tile reds on a pending/failed data-op",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the ship-time backfill executor records run status", kind: "auto", exec_kind: "grep", params: { pattern: "data_op_runs", path: "src/lib/agent-jobs.ts", expect: "present" } },
            { position: 3, description: "CLAUDE.md carries the backfill-must-be-tracked convention", kind: "auto", exec_kind: "grep", params: { pattern: "_backfill-", path: "CLAUDE.md", expect: "present" } },
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
