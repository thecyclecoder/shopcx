/**
 * Seed Avalara (AvaTax) sandbox credentials onto the Superfoods workspace.
 *
 * Sandbox account 2000182415, company code DEFAULT. License key is
 * AES-256-GCM encrypted before insert (uses ENCRYPTION_KEY from
 * .env.local, same convention as every other stored secret).
 *
 * The origin (ship-from) address comes from the workspace's existing
 * return_address — the EasyPost Amplifier warehouse in Austin.
 *
 * avalara_enabled stays FALSE. Admin flips it on via Settings →
 * Integrations → Avalara after a successful Verify connection.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
import { encrypt } from "../src/lib/crypto";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { data: ws, error: readErr } = await admin
    .from("workspaces")
    .select("return_address, avalara_account_id, avalara_enabled")
    .eq("id", WS)
    .single();
  if (readErr) throw readErr;

  // Build the origin address from the existing return_address. Falls
  // back to hardcoded warehouse if return_address is missing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ret = (ws?.return_address || {}) as any;
  const origin = {
    line1: ret.street1 || "8015 Burleson Road",
    line2: ret.street2 || "Unit 100 Dock 24",
    city: ret.city || "Austin",
    region: stateTo2Letter(ret.state) || "TX",
    postalCode: ret.zip || "78744",
    country: ret.country || "US",
  };

  const updates = {
    avalara_account_id: "2000182415",
    avalara_license_key_encrypted: encrypt("D5BE4FFE75CDF0C0"),
    avalara_company_code: "DEFAULT",
    avalara_environment: "production",
    avalara_origin_address: origin,
    avalara_default_tax_code: "PF050144", // supplements — covers the Tabs/Coffee/Creamer/ACV catalog
    avalara_enabled: false,
  };

  const { error } = await admin
    .from("workspaces")
    .update(updates)
    .eq("id", WS);
  if (error) throw error;

  console.log("✓ Seeded Avalara sandbox credentials onto workspace", WS);
  console.log("  account_id      :", updates.avalara_account_id);
  console.log("  company_code    :", updates.avalara_company_code);
  console.log("  environment     :", updates.avalara_environment);
  console.log("  default_tax_code:", updates.avalara_default_tax_code);
  console.log("  origin          :", JSON.stringify(origin));
  console.log("  enabled         : false (flip via Settings → Integrations → Avalara)");
}

function stateTo2Letter(state: string | undefined): string | null {
  if (!state) return null;
  const s = state.trim();
  if (s.length === 2) return s.toUpperCase();
  const map: Record<string, string> = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
    hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
    massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
    montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
    ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
    vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
    wyoming: "WY",
  };
  return map[s.toLowerCase()] || null;
}

main().catch((e) => { console.error(e); process.exit(1); });
