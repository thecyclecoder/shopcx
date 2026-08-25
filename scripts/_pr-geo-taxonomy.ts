/**
 * Is Puerto Rico reachable via Meta's countries:["US"] targeting, or is it its own country key?
 * Settles WHY the CEO is seeing our ads in PR: geo inclusion vs `location_types:["home","recent"]`
 * serving him on his registered HOME location.
 * READ-ONLY — Meta targeting-search reads only.
 */
import "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const q = (path: string) =>
    fetch(`https://graph.facebook.com/v21.0/${path}&access_token=${encodeURIComponent(token)}`).then((r) => r.json());

  console.log("=== Meta geo taxonomy: Puerto Rico ===");
  const j = await q(`search?type=adgeolocation&q=Puerto%20Rico&limit=10`);
  for (const r of (j.data ?? []) as Array<Record<string, unknown>>) {
    console.log(`  type=${r.type} key=${r.key} name=${r.name} country_code=${r.country_code ?? "—"} country_name=${r.country_name ?? "—"} supports_region=${r.supports_region ?? "—"}`);
  }
  if (j.error) console.log("  error:", JSON.stringify(j.error));

  console.log("\n=== Is PR a REGION under US, or its own country? ===");
  const regions = await q(`search?type=adgeolocation&location_types=["region"]&q=Puerto&limit=10`);
  for (const r of (regions.data ?? []) as Array<Record<string, unknown>>) {
    console.log(`  region key=${r.key} name=${r.name} country_code=${r.country_code}`);
  }
  const countries = await q(`search?type=adgeolocation&location_types=["country"]&q=Puerto&limit=10`);
  for (const r of (countries.data ?? []) as Array<Record<string, unknown>>) {
    console.log(`  country key=${r.key} name=${r.name}`);
  }

  console.log("\n=== US region list — does it contain Puerto Rico? ===");
  const usRegions = await q(`search?type=adgeolocation&location_types=["region"]&q=&country_code=US&limit=100`);
  const names = ((usRegions.data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.name));
  console.log(`  US regions returned: ${names.length}`);
  const pr = ((usRegions.data ?? []) as Array<Record<string, unknown>>).filter((r) => /puerto/i.test(String(r.name)));
  if (pr.length) {
    for (const r of pr) console.log(`  ✅ PR IS a US region: key=${r.key} name=${r.name} → excludable via excluded_geo_locations.regions[{key}]`);
  } else {
    console.log(`  ❌ Puerto Rico is NOT in the US region list.`);
    console.log(`     ⇒ countries:["US"] does NOT deliver to PR, and the CEO is being served because`);
    console.log(`       location_types:["home","recent"] matches his registered HOME (a US location),`);
    console.log(`       not his current physical location.`);
  }
  console.log(`  sample US regions: ${names.slice(0, 8).join(", ")}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
