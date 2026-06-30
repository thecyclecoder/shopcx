// check-growth-cutover-ready — the Phase-1 pre-flight readiness gate for the
// growth-director-live-autonomous-cutover (M6 of goals/growth). Read-only: it
// asks "is every precondition for flipping function_autonomy('growth') to
// live=true, autonomous=true actually in place?" and exits non-zero on the
// first missing one with a labeled reason.
//
// The six checks (in order, each labeled in the output):
//   a. function_autonomy('growth') row exists                       — the toggle target.
//   b. ≥1 iteration_policies.status='active' row for the workspace  — the Meta
//      iteration engine has a policy to read (skip with --allow-empty-policy
//      to permit a dormant cutover).
//   c. storefront_optimizer_policy.active=true for the workspace    — the storefront
//      optimizer is ON (propose-and-approve mode is enough — not enforced).
//   d. ≥1 ad_spend_budgets row for the workspace with platform='meta' — the spend
//      rail has a ceiling on the coffee ad account.
//   e. director-recap renders for growth — a dry generateDirectorRecap call against
//      a far-past date returns { ok:true } or { ok:false, reason:'no_activity' }
//      (never throws). The far-past date guarantees no activity ⇒ no writes,
//      preserving the read-only invariant of this script.
//   f. growth-director handler registered in scripts/builder-worker.ts — grep the
//      file for the runGrowthDirectorJob dispatch case.
//
// Usage:
//   npx tsx scripts/check-growth-cutover-ready.ts <WORKSPACE_ID> [--allow-empty-policy]
//
// Exit codes:
//   0 — every precondition met
//   1 — invocation error (bad/missing argv, env not set)
//   2 — a precondition is missing (the reason is printed to stderr)
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";
import { generateDirectorRecap } from "../src/lib/agents/director-recap";

const GROWTH_SLUG = "growth";
// Far in the past — guaranteed no director_activity / approvals / merged builds.
// generateDirectorRecap returns { ok:false, reason:'no_activity' } and writes nothing.
const DRY_RECAP_DATE = "2020-01-01";
const BUILDER_WORKER_PATH = resolve(__dirname, "builder-worker.ts");

function fail(reason: string): never {
  console.error(`✗ ${reason}`);
  process.exit(2);
}

function ok(line: string): void {
  console.log(`✓ ${line}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const workspaceId = positional[0];
  if (!workspaceId) {
    console.error(
      "usage: npx tsx scripts/check-growth-cutover-ready.ts <WORKSPACE_ID> [--allow-empty-policy]",
    );
    process.exit(1);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    console.error(`workspace_id is not a uuid: ${workspaceId}`);
    process.exit(1);
  }
  const allowEmptyPolicy = flags.has("--allow-empty-policy");

  const admin = createAdminClient();

  // (a) function_autonomy('growth') row exists
  {
    const { data, error } = await admin
      .from("function_autonomy")
      .select("function_slug, live, autonomous")
      .eq("function_slug", GROWTH_SLUG)
      .maybeSingle();
    if (error) fail(`function_autonomy probe failed: ${error.message}`);
    if (!data) fail(`function_autonomy('${GROWTH_SLUG}') row is missing — seed it before cutover`);
    ok(`function_autonomy('${GROWTH_SLUG}') row exists (live=${data.live}, autonomous=${data.autonomous})`);
  }

  // (b) ≥1 iteration_policies.status='active' row for the workspace
  {
    const { count, error } = await admin
      .from("iteration_policies")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "active");
    if (error) fail(`iteration_policies probe failed: ${error.message}`);
    if (!count || count < 1) {
      if (allowEmptyPolicy) {
        ok(`iteration_policies has no active row (--allow-empty-policy → dormant cutover)`);
      } else {
        fail(
          `iteration_policies has no status='active' row for workspace ${workspaceId} — author + activate one, or re-run with --allow-empty-policy for a dormant cutover`,
        );
      }
    } else {
      ok(`iteration_policies has ${count} active row(s) for workspace`);
    }
  }

  // (c) storefront_optimizer_policy.active=true for the workspace
  {
    const { data, error } = await admin
      .from("storefront_optimizer_policy")
      .select("active")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) fail(`storefront_optimizer_policy probe failed: ${error.message}`);
    if (!data) fail(`storefront_optimizer_policy row missing for workspace ${workspaceId}`);
    if (!data.active) fail(`storefront_optimizer_policy.active is false for workspace ${workspaceId}`);
    ok(`storefront_optimizer_policy.active=true`);
  }

  // (d) ≥1 ad_spend_budgets row for the workspace's coffee (Meta) ad account
  {
    const { count, error } = await admin
      .from("ad_spend_budgets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("platform", "meta");
    if (error) fail(`ad_spend_budgets probe failed: ${error.message}`);
    if (!count || count < 1) {
      fail(`ad_spend_budgets has no platform='meta' ceiling for workspace ${workspaceId} — set one before cutover`);
    }
    ok(`ad_spend_budgets has ${count} meta row(s) for workspace`);
  }

  // (e) generateDirectorRecap dry call — far-past date ⇒ no activity ⇒ no writes
  {
    let result: Awaited<ReturnType<typeof generateDirectorRecap>>;
    try {
      result = await generateDirectorRecap(workspaceId, DRY_RECAP_DATE);
    } catch (e) {
      fail(`director-recap dry call threw: ${(e as Error).message}`);
    }
    const okResult =
      result.ok === true || (result.ok === false && result.reason === "no_activity");
    if (!okResult) {
      fail(`director-recap dry call returned unexpected: ${JSON.stringify(result)}`);
    }
    ok(`director-recap dry call (${DRY_RECAP_DATE}) → ${result.ok ? "ok" : "no_activity"}`);
  }

  // (f) growth-director handler registered in scripts/builder-worker.ts
  {
    if (!existsSync(BUILDER_WORKER_PATH)) {
      fail(`builder-worker.ts not found at ${BUILDER_WORKER_PATH}`);
    }
    const src = readFileSync(BUILDER_WORKER_PATH, "utf8");
    const hasHandler = /async function runGrowthDirectorJob\b/.test(src);
    const hasDispatch = /job\.kind === "growth-director"/.test(src);
    if (!hasHandler) fail(`builder-worker.ts is missing runGrowthDirectorJob`);
    if (!hasDispatch) fail(`builder-worker.ts is missing the growth-director dispatch case`);
    ok(`scripts/builder-worker.ts registers the growth-director handler`);
  }

  console.log("\nready: every growth-cutover precondition is met.");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
