/**
 * Platform spec from the 2026-07-07 order_refunds incident: PR #1265 merged code
 * that queried public.order_refunds with NO migration to create it, and passed
 * spec-test + review GREEN because the spec-test mocks the Supabase client — the
 * non-existent table was never exercised. The guard shipped inert; only a human
 * caught it. Durable fix: a static CI check (run in the BUILD lane, not just
 * human predeploy) that fails when code references a table no migration creates.
 * platform-owned. Lands in_review.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const s = await authorSpecRowStructured(
    WS,
    "ci-guard-table-refs-have-migrations",
    {
      title: "CI guard: every table a code path queries must have a migration that creates it",
      why: "A refund-idempotency spec merged code that reads and writes a table with no migration to create it, and it passed spec-test and review completely green — because the spec-test mocks the Supabase client, so the non-existent table was never exercised. The guard shipped totally inert (its lookup silently returned null, its mirror insert silently failed) and only a human noticed days later. The autonomous pipeline auto-merges, so a green build is trusted; a build that references a table nothing creates must be a RED build, caught before merge, not by a human afterward. The parsing needed already exists — the RLS check already reads every migration and knows the full set of created tables.",
      what: "A static check that builds the set of tables created across all migrations (plus a small allowlist for views / external / system tables), scans the codebase for literal table references, and fails when any referenced table has no migration creating it — wired both into predeploy AND into the autonomous build/spec-test lane so the box fails such a build before it can merge.",
      summary: "**Brain refs:** [[../operational-rules]] [[../recipes/write-a-migration-apply-script]]. Grounded in: the 2026-07-07 order_refunds incident (PR #1265 merged .from('order_refunds') reads/writes in src/lib/refund.ts + action-executor + returns with no supabase/migrations file creating the table; spec-test mocked the admin client so it passed). Reuse the migration-parsing already in scripts/_check-rls-on-new-tables.ts (it tracks every created public table — 232 at time of writing). Sibling of the existing predeploy rails scripts/_check-no-hard-destructive-migrations.ts + _check-rls-on-new-tables.ts.",
      owner: "platform",
      parent: '[[../functions/platform]] — "Autonomous build platform" mandate: a build that references a database table no migration creates must fail red in the build lane, never merge green and ship inert.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — the static check: literal table refs must have a creating migration",
          why: "A deterministic scan of code table-references against the set of migration-created tables turns 'queries a table that doesn't exist' from a silent runtime no-op into a red CI failure — the exact gap #1265 slipped through.",
          what: "A check that parses all migrations for created tables (reusing the RLS check's parser), scans src for literal table references, and fails on any referenced table with no creating migration, honoring a small explicit allowlist for legitimate non-migration tables (views, external, system).",
          body: "Add scripts/_check-table-refs-have-migrations.ts. Build the created-table set by parsing supabase/migrations/*.sql for `create table [if not exists] public.<name>` (reuse the parser in scripts/_check-rls-on-new-tables.ts). Scan src/ for literal `.from(\"<name>\")` / `.from('<name>')` references (skip dynamic `.from(variable)` — flag only string literals). Fail the check listing any referenced table not in {created ∪ allowlist}. Maintain an explicit allowlist file for views, RPC-backed names, and external/system tables so legitimate refs don't false-positive. Add the `check:table-refs-have-migrations` npm script. Cite the RLS-check parser + the migrations dir.",
          verification: "Reintroducing the #1265 shape (a `.from('order_refunds')` with no creating migration) fails the check with that table named. A table that IS created by a migration passes. An allowlisted view/external ref passes. A dynamic `.from(variable)` ref does not trigger a false failure. Running the check against current main passes (no false positives on the existing 232 tables).",
          status: "planned",
        },
        {
          title: "Phase 2 — run it in the build lane, not just human predeploy",
          why: "#1265 was merged by the autonomous box, which trusts a green build; a predeploy-only check a human runs later would not have stopped the merge. The guard must fire where the box gates.",
          what: "Chain the new check into the predeploy rail AND into the autonomous build/spec-test lane so a build whose code references an uncreated table fails before the box can merge it.",
          body: "Add check:table-refs-have-migrations to the predeploy chain alongside check:rls-on-new-tables + check:no-hard-destructive-migrations. Also invoke it in the autonomous build/spec-test path (the same lane that runs spec-test / security-review before merge) so the box marks the build failed rather than merging green — closing the 'spec-test mocks the DB so a missing table passes' hole. Cite the predeploy chain + the build/spec-test lane.",
          verification: "A build introducing a `.from('newtable')` with no migration is failed by the box in the build lane (not merged), with the table named in the failure. The check appears in the predeploy chain. A normal build (all referenced tables migrated) proceeds unaffected.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#build" },
  );
  console.log("pipeline-gap spec:", s ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
