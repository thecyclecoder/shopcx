/**
 * Probe: verifies `src/lib/commerce/subscription.ts::listSubscriptions` walks
 * past PostgREST's 1000-row cap and prices Appstle-baked subs to the cent
 * (commerce-sdk-display-operations Phase 1 verification).
 *
 * Two checks, matching the spec's Verification block:
 *
 *   1. Walk past 1000 — against a workspace with > 1000 subs, expect the SDK
 *      returns > 1000 rows. Proves the cursor pagination in listSubscriptions.
 *      Optional: skipped with a warning when no such workspace exists yet.
 *
 *   2. Appstle canary — against a specific grandfathered Appstle sub, expect
 *      the SDK's `pricing.total_cents` matches the portal's rendered total to
 *      the cent (compares the SDK's priced total vs `priceSubscription` invoked
 *      directly — same helper today, but the probe locks in the invariant that
 *      the two agree). Optional; --canary-sub=<uuid> switches it on.
 *
 * Usage:
 *   npx tsx scripts/_probe-commerce-display-subs.ts \
 *     [--workspace=<uuid>] [--canary-sub=<uuid>]
 *
 * When --workspace is omitted, the probe picks the largest workspace by
 * subscription count so it exercises the walk-past-1000 path automatically on
 * prod. --canary-sub is opt-in — supply an Appstle sub id whose portal total is
 * known; the probe fails if the SDK's pricing.total_cents drifts from
 * `priceSubscription`'s own rollup.
 */
import { createAdminClient } from "./_bootstrap";
import { listSubscriptions, getSubscription } from "@/lib/commerce/subscription";
import { priceSubscription } from "@/lib/commerce/price";

function parseArgs(argv: string[]): { workspace?: string; canarySub?: string } {
  const out: { workspace?: string; canarySub?: string } = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--canary-sub=")) out.canarySub = a.slice("--canary-sub=".length);
  }
  return out;
}

async function pickLargestWorkspace(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  // Bucket by workspace_id across a wide sample so we pick the one with the
  // most subscriptions to exercise the >1000 walk.
  const { data, error } = await admin
    .from("subscriptions")
    .select("workspace_id")
    .limit(50_000);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ workspace_id: string }>) {
    counts.set(r.workspace_id, (counts.get(r.workspace_id) || 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [wsId, n] of counts.entries()) {
    if (n > bestCount) {
      best = wsId;
      bestCount = n;
    }
  }
  return best;
}

async function main() {
  const { workspace, canarySub } = parseArgs(process.argv);
  const admin = createAdminClient();
  let failed = 0;

  // ── Check 1: walk past 1000 ────────────────────────────────────────
  const workspaceId = workspace ?? (await pickLargestWorkspace(admin));
  if (!workspaceId) {
    console.warn("WARN: no workspace with subscriptions found — skipping walk-past-1000 check");
  } else {
    const { count, error: countErr } = await admin
      .from("subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (countErr) throw countErr;
    const dbCount = count ?? 0;
    console.log(`workspace=${workspaceId} · subscriptions=${dbCount}`);

    const rows = await listSubscriptions(workspaceId, { page_size: 500 });
    console.log(`listSubscriptions returned ${rows.length} rows`);

    if (dbCount > 1000) {
      if (rows.length > 1000) {
        console.log(`PASS: walked past the 1000-row cap (${rows.length} rows)`);
      } else {
        console.error(`FAIL: workspace has ${dbCount} subs but SDK returned only ${rows.length}`);
        failed++;
      }
    } else {
      console.warn(
        `SKIP: workspace has only ${dbCount} subs (< 1000). Pick a bigger workspace via --workspace=<uuid> to exercise the walk-past-1000 check.`,
      );
      // Still assert the SDK returned all rows for this smaller workspace.
      if (rows.length !== dbCount) {
        console.error(`FAIL: expected ${dbCount} rows, got ${rows.length}`);
        failed++;
      } else {
        console.log(`PASS: SDK returned all ${rows.length} rows (matches DB count)`);
      }
    }
  }

  // ── Check 2: Appstle canary pricing to the cent ────────────────────
  if (canarySub) {
    if (!workspaceId) {
      console.error("FAIL: --canary-sub requires --workspace to be set (or discoverable)");
      failed++;
    } else {
      const view = await getSubscription(workspaceId, canarySub);
      const { data: rawSub, error: rawErr } = await admin
        .from("subscriptions")
        .select("*")
        .eq("id", canarySub)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (rawErr) throw rawErr;
      if (!rawSub) {
        console.error(`FAIL: canary sub ${canarySub} not found in workspace ${workspaceId}`);
        failed++;
      } else {
        const { pricing } = await priceSubscription(workspaceId, rawSub as Record<string, unknown>);
        const sdkTotal = view.pricing.total_cents;
        const priceTotal = pricing.total_cents;
        if (sdkTotal === priceTotal) {
          console.log(
            `PASS: canary ${canarySub} — SDK pricing.total_cents (${sdkTotal}) matches priceSubscription (${priceTotal}) to the cent`,
          );
        } else {
          console.error(
            `FAIL: canary ${canarySub} — SDK pricing.total_cents (${sdkTotal}) drifted from priceSubscription (${priceTotal})`,
          );
          failed++;
        }
      }
    }
  } else {
    console.warn("SKIP: canary check — supply --canary-sub=<uuid> to run (opt-in)");
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll enabled checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
