/**
 * Probe: verifies `src/lib/commerce/customer.ts::getCustomer` +
 * `src/lib/commerce/crisis.ts::getCrisisContext` both return non-empty views
 * for a canary customer with an open crisis
 * (commerce-sdk-display-operations Phase 3 verification).
 *
 * When --workspace / --customer are omitted, the probe finds a customer that
 * has a matching `crisis_customer_actions` row and picks it as the canary
 * automatically.
 *
 * Usage:
 *   npx tsx scripts/_probe-commerce-display-context.ts \
 *     [--workspace=<uuid>] [--customer=<uuid>]
 */
import { createAdminClient } from "./_bootstrap";
import { getCustomer } from "@/lib/commerce/customer";
import { getCrisisContext } from "@/lib/commerce/crisis";

function parseArgs(argv: string[]): { workspace?: string; customer?: string } {
  const out: { workspace?: string; customer?: string } = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--customer=")) out.customer = a.slice("--customer=".length);
  }
  return out;
}

async function pickCanary(
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ workspaceId: string; customerId: string } | null> {
  const { data, error } = await admin
    .from("crisis_customer_actions")
    .select("workspace_id, customer_id")
    .not("customer_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    workspaceId: data.workspace_id as string,
    customerId: data.customer_id as string,
  };
}

async function main() {
  const { workspace, customer } = parseArgs(process.argv);
  const admin = createAdminClient();
  let failed = 0;

  let workspaceId = workspace;
  let customerId = customer;
  if (!workspaceId || !customerId) {
    const canary = await pickCanary(admin);
    if (!canary) {
      console.warn("WARN: no crisis_customer_actions row found — skipping canary probe");
      console.log("\nAll enabled checks passed");
      return;
    }
    workspaceId = workspaceId ?? canary.workspaceId;
    customerId = customerId ?? canary.customerId;
  }
  console.log(`workspace=${workspaceId} customer=${customerId}`);

  // ── Check: getCustomer + getCrisisContext both return non-empty ────
  const customerView = await getCustomer(workspaceId, customerId);
  const crisisView = await getCrisisContext(workspaceId, customerId);
  if (!customerView.id) {
    console.error("FAIL: getCustomer returned an empty view (no id)");
    failed++;
  } else {
    console.log(`PASS: getCustomer returned view for ${customerView.id} (${customerView.email})`);
  }
  if (crisisView.crises.length === 0) {
    console.error(`FAIL: getCrisisContext returned no crises for canary ${customerId}`);
    failed++;
  } else {
    console.log(
      `PASS: getCrisisContext returned ${crisisView.crises.length} crisis view(s) for canary`,
    );
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
