import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s = await authorSpecRowStructured(WS, "builder-migration-apply-uses-working-pgclient-not-broken-db-push", {
    title: "Builder applies migrations via the working pgClient apply-script, not the broken db push lane",
    why: "The assisted-purchase-playbook build stalled because the builder's migration-apply action runs `supabase db push --db-url $SUPABASE_POOLER_URL`, but that env var is UNSET on the builder — so the CLI falls back to a nonexistent local socket and fails to connect ('dial unix /tmp/.s.PGSQL.5432: no such file or directory'). The migration never applied (the assisted-purchase playbooks were not seeded), yet the build sat at needs_approval waiting on a command that cannot succeed. Meanwhile the sanctioned apply-script pattern (scripts/apply-*.ts using the pgClient pooler connection with SUPABASE_DB_PASSWORD, which IS set) works — the backfill build used exactly that and succeeded. So the box has two migration-apply paths, one broken (db push, depends on an unset var) and one working (pgClient apply-script, the brain-mandated pattern), and builds that draw the broken one silently fail to apply their schema. Any spec with a migration is at risk.",
    what: "The builder's migration-apply lane uses the working method for every migration — the pgClient apply-script pattern (SUPABASE_DB_PASSWORD, already present) — instead of `supabase db push` against the unset pooler URL; and it verifies the migration's effect actually landed before marking the action succeeded, so a silent connect-failure can never pass as applied.",
    summary: "**Brain refs:** [[../recipes/write-a-migration-apply-script]] [[../operational-rules]] [[../libraries/control-tower]]. Grounded in the 2026-07-07 assisted-purchase-playbook stall: pending action cmd `npx supabase db push --db-url \"$SUPABASE_POOLER_URL\" --include-all` failed with `failed to connect to postgres: host=/tmp ... dial unix /tmp/.s.PGSQL.5432` because $SUPABASE_POOLER_URL is empty on the builder; the seed migration never applied (playbooks table shows 0 assisted-purchase rows). The working path: scripts/apply-*.ts via pgClient()/SUPABASE_DB_PASSWORD (operational-rules 'apply it in the same session' + the write-a-migration-apply-script recipe). The builder-worker migration-apply step is the fix site.",
    owner: "platform",
    parent: '[[../functions/platform]] — "Autonomous build platform" mandate: a build that produces a migration must apply it with a method that actually works on the builder, and must verify the apply landed — never stall on a command that cannot connect.',
    blocked_by: [],
    phases: [
      {
        title: "Phase 1 — switch the builder migration-apply to the working pgClient apply-script method",
        why: "The db push command depends on an env var that is unset on the builder; the pgClient apply-script uses SUPABASE_DB_PASSWORD which is present and is the brain-mandated pattern, so switching to it removes the dependency on the broken var entirely.",
        what: "When a build produces a migration, the builder applies it by generating/running the scripts/apply-*.ts pgClient apply-script (SUPABASE_DB_PASSWORD pooler connection) instead of emitting a `supabase db push --db-url $SUPABASE_POOLER_URL` action.",
        body: "In the builder-worker migration-apply step (scripts/builder-worker.ts), replace the `supabase db push --db-url \"$SUPABASE_POOLER_URL\"` apply-action with the pgClient apply-script pattern from [[../recipes/write-a-migration-apply-script]] — connect via poolerConnectionString()/pgClient() using SUPABASE_DB_PASSWORD (confirmed set on the builder) and run the migration SQL. If db push must be retained anywhere, set $SUPABASE_POOLER_URL on the builder so it resolves; but prefer the apply-script since it is the documented, env-present path. Cite the builder migration-apply step + the apply-script recipe.",
        verification: "A build that produces a migration applies it successfully on the builder (the schema/rows land in the DB) with no dependency on $SUPABASE_POOLER_URL. Re-running the assisted-purchase-playbook seed via the new path seeds the two playbooks (playbooks table shows the Assisted Order/Subscription Purchase rows). No apply action emits the failing `db push --db-url \"$SUPABASE_POOLER_URL\"` form.",
        status: "planned",
      },
      {
        title: "Phase 2 — verify the apply landed before marking the action succeeded",
        why: "The AP failure was doubly bad: the command failed AND the action still sat as if it might be done. An apply must be confirmed by probing the DB so a connect-failure or no-op can never pass as applied.",
        what: "After running a migration apply, the builder probes that the migration's effect exists in the DB (the new table/column/constraint/rows) and only marks the action succeeded on a positive probe; a failed probe fails the action with the real error.",
        body: "In the builder migration-apply step, after applying, run a lightweight verification query (the table/column/constraint the migration creates, or a representative seeded row) and gate success on it — mirroring the verify tail the apply-*.ts scripts already print. On a failed probe, mark the action failed with the connect/DDL error surfaced (not a silent pass). Cite the builder apply step + the verify pattern in the apply scripts.",
        verification: "An apply that fails to connect (e.g. the old broken db push) is marked FAILED with the connect error, never left ambiguous. An apply that succeeds is confirmed by a positive DB probe before the action is marked done. A no-op apply that doesn't create the expected object fails the probe.",
        status: "planned",
      },
    ],
  }, "planned", { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#build" });
  console.log("box-push spec:", s ? "authored" : "FAILED");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
