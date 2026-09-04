import { loadEnv } from "./scripts/_bootstrap";
loadEnv();
import { chargeOneTimeOrder } from "./src/lib/one-time-charge";
import { createAdminClient } from "./src/lib/supabase/admin";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SUSAN = "shall7613@aol.com";
const KCUPS_COCOA = "c1e1e38d-80d9-4bc7-aee2-7f44a2f30fcd";
const HER_RATE_CENTS = 5996; // her subscription line price, not the $79.95 catalog

async function main() {
  const admin = createAdminClient();
  const { data: cust } = await admin
    .from("customers")
    .select("id, email")
    .eq("email", SUSAN)
    .single();
  if (!cust) throw new Error("customer not found");

  const res = await chargeOneTimeOrder({
    workspaceId: WORKSPACE_ID,
    customerId: cust.id,
    items: [{ variant_id: KCUPS_COCOA, quantity: 1, unit_price_cents: HER_RATE_CENTS }],
    sourceName: "cs-one-time",
    reason: "ticket 303ef89d — September box; sub resumes 2 boxes 2026-11-02",
  });

  console.log("RESULT:", JSON.stringify(res, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("THREW:", e.message);
    process.exit(1);
  });
