/**
 * What ARE these tax codes? Ask Avalara's own definitions endpoint rather than guessing.
 * CEO question 2026-08-31: "is PF050102 supplement code?"
 * READ-ONLY against Avalara (GET /api/v2/definitions/taxcodes).
 */
import { createAdminClient } from "./_bootstrap";
import { decrypt } from "../src/lib/crypto";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CODES = ["PF050144", "PF050100", "PF050101", "PF050102", "PC040100", "PC040101", "P0000000"];

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin.from("workspaces")
    .select("avalara_account_id, avalara_license_key_encrypted, avalara_environment").eq("id", WS).single();
  if (error) throw new Error(`workspaces: ${error.message}`);
  const auth = "Basic " + Buffer.from(`${data.avalara_account_id}:${decrypt(data.avalara_license_key_encrypted)}`).toString("base64");
  const host = data.avalara_environment === "production" ? "https://rest.avatax.com" : "https://sandbox-rest.avatax.com";

  for (const code of CODES) {
    const url = `${host}/api/v2/definitions/taxcodes?$filter=${encodeURIComponent(`taxCode eq '${code}'`)}`;
    const r = await fetch(url, { headers: { Authorization: auth, "X-Avalara-Client": "ShopCX-Integration; 1.0" } });
    if (!r.ok) { console.log(`${code.padEnd(10)} HTTP ${r.status}`); continue; }
    const j = await r.json() as { value?: Array<{ taxCode?: string; description?: string; taxCodeTypeId?: string; isActive?: boolean }> };
    const hit = (j.value ?? [])[0];
    if (!hit) { console.log(`${code.padEnd(10)} ❌ NOT FOUND in Avalara's tax-code definitions`); continue; }
    console.log(`${code.padEnd(10)} ✅ ${hit.description ?? "(no description)"}   [type=${hit.taxCodeTypeId ?? "?"} active=${hit.isActive}]`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
