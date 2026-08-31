/**
 * Find the REAL Avalara tax codes for dietary supplements and for food/groceries.
 * Our mapping is wrong on both: PF050144 does not exist, and PC040100 is CLOTHING.
 * Avalara's $filter rejects contains(), so page the catalog and match locally. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { decrypt } from "../src/lib/crypto";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin.from("workspaces")
    .select("avalara_account_id, avalara_license_key_encrypted, avalara_environment").eq("id", WS).single();
  if (error) throw new Error(`workspaces: ${error.message}`);
  const auth = "Basic " + Buffer.from(`${data.avalara_account_id}:${decrypt(data.avalara_license_key_encrypted)}`).toString("base64");
  const host = data.avalara_environment === "production" ? "https://rest.avatax.com" : "https://sandbox-rest.avatax.com";

  const all: Array<{ taxCode: string; description: string; isActive?: boolean }> = [];
  for (let skip = 0; skip < 4000; skip += 500) {
    const r = await fetch(`${host}/api/v2/definitions/taxcodes?$top=500&$skip=${skip}`, {
      headers: { Authorization: auth, "X-Avalara-Client": "ShopCX-Integration; 1.0" },
    });
    if (!r.ok) { console.log(`page skip=${skip}: HTTP ${r.status}`); break; }
    const j = await r.json() as { value?: Array<{ taxCode?: string; description?: string; isActive?: boolean }> };
    const rows = j.value ?? [];
    all.push(...rows.map((x) => ({ taxCode: String(x.taxCode), description: String(x.description ?? ""), isActive: x.isActive })));
    if (rows.length < 500) break;
  }
  console.log(`pulled ${all.length} tax codes\n`);

  const show = (label: string, re: RegExp) => {
    const hits = all.filter((x) => x.isActive !== false && re.test(x.description));
    console.log(`=== ${label} (${hits.length}) ===`);
    for (const h of hits.slice(0, 18)) console.log(`   ${h.taxCode.padEnd(11)} ${h.description.slice(0, 100)}`);
    console.log();
  };

  show("dietary supplements", /dietary supplement|supplement/i);
  show("vitamins", /vitamin/i);
  show("food & food ingredients (general)", /food (and|&) food ingredients\s*[-–]?\s*(general|$)/i);
  show("groceries", /grocer/i);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
