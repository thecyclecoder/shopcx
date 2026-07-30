import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "fix-list-spec-phase-anomalies-rpc-quote-position-keyword",
    {
      title: "Fix the list_spec_phase_anomalies migration: 'position' is a reserved keyword and must be quoted — the RPC never applied and the spec-drift anomaly sweep throws",
      why: "The migration 20261003120000_list_spec_phase_anomalies_rpc.sql defines the function with a column named position, unquoted, in both the RETURNS TABLE list and the SELECT alias (p.position as position). position is a reserved keyword in that grammar position, so Postgres raises 42601 syntax error at or near \"position\" and the CREATE FUNCTION fails — the RPC has never existed on any environment (verified: the function is absent in the live DB, and quoting reproduces/fixes it). Because listSpecPhaseAnomalies in src/lib/specs-table.ts calls this RPC and throws on error, the reconciler's spec-drift anomaly sweep (orphan spec_phases + shipped-without-provenance gaps) throws every run. The broken migration also re-errors on every reconcile/replay, contributing recurring syntax-error log noise.",
      what: "Quote the position identifier in the migration so the function creates cleanly and the spec-phase anomaly RPC exists.",
      summary: "Edit supabase/migrations/20261003120000_list_spec_phase_anomalies_rpc.sql to quote \"position\" in the RETURNS TABLE column list (line ~31) and the SELECT alias (line ~43, p.position as \"position\"). The file never applied anywhere (hard syntax error), so fixing it in place is safe; the reconciler then auto-applies it and list_spec_phase_anomalies starts existing.",
      owner: "platform",
      parent: '[[../functions/platform]] — "Autonomous build platform" mandate: the spec-phase anomaly RPC underpins the reconciler\'s spec-drift sweep; a syntax-broken migration means the RPC never existed and the sweep throws. See [[../libraries/specs-table]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Quote the 'position' keyword so the function applies",
          why: "position is reserved in the RETURNS TABLE / alias grammar, so the unquoted form is a hard 42601 syntax error and the CREATE FUNCTION never runs.",
          what: "Quote \"position\" in the RETURNS TABLE column and the SELECT alias in the existing migration.",
          body: "In supabase/migrations/20261003120000_list_spec_phase_anomalies_rpc.sql: change the RETURNS TABLE column definition `position int,` to `\"position\" int,` (~line 31), and the projection `p.position as position,` to `p.position as \"position\",` (~line 43). Quoting keeps the lowercase column name `position`, which is what the caller in src/lib/specs-table.ts (listSpecPhaseAnomalies) reads off each row, so no TS change is needed. The migration has NEVER successfully applied on any environment (it is a hard syntax error, so it created nothing and recorded no schema_migrations row) — editing it in place is safe and does not rewrite applied history; once syntactically valid the migration-drift reconciler will auto-apply it (additive function) and record the version. Do NOT add a second migration — that would leave the broken 20261003120000 re-erroring on every replay. Verify afterward that public.list_spec_phase_anomalies exists and listSpecPhaseAnomalies returns without throwing. Keep the docs/brain/libraries/specs-table.md reference accurate per CLAUDE.md.",
          verification: "- tsc clean\n- the migration quotes \"position\" (no unquoted position identifier remains)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the migration quotes the position keyword", kind: "auto", exec_kind: "grep", params: { pattern: "\"position\"", path: "supabase/migrations/20261003120000_list_spec_phase_anomalies_rpc.sql", expect: "present" } },
            { position: 3, description: "no unquoted 'position int' column definition remains", kind: "auto", exec_kind: "grep", params: { pattern: "  position int,", path: "supabase/migrations/20261003120000_list_spec_phase_anomalies_rpc.sql", expect: "absent" } },
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
