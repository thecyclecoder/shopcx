/** Why did Dahlia make this ad? Uses the ads-read-sdk, not raw .from(). READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { getAd, traceAdOrigin, getAngle } from "../src/lib/ads/ads-read-sdk";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CAMPAIGN = process.argv[2] ?? "3743b942-be6c-4fda-a8cb-458367ffe6f2";

async function main() {
  const admin = createAdminClient();

  const trace = await traceAdOrigin(admin, { workspaceId: WS, campaignId: CAMPAIGN }) as Record<string, unknown>;
  console.log("=== TRACE (non-ad fields) ===");
  for (const [k, v] of Object.entries(trace)) {
    if (k === "ad") continue;
    console.log(`  ${k}:\n    ${String(typeof v === "object" ? JSON.stringify(v, null, 2).replace(/\n/g, "\n    ") : v).slice(0, 1200)}`);
  }

  const ad = await getAd(admin, { workspaceId: WS, campaignId: CAMPAIGN }) as Record<string, unknown> | null;
  if (!ad) return;

  console.log("\n=== MAX COPY-QC VERDICT ===");
  console.log(JSON.stringify(ad.maxCopyVerdict, null, 2).slice(0, 2000));

  const angleId = String(ad.angleId ?? "");
  if (!angleId) { console.log("\n(no angleId)"); return; }
  const angle = await getAngle(admin, { workspaceId: WS, angleId }) as Record<string, unknown> | null;
  console.log("\n=== ANGLE ===");
  for (const [k, v] of Object.entries(angle ?? {})) {
    if (v === null || k === "metadata") continue;
    console.log(`  ${k.padEnd(22)} ${String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 400)}`);
  }
  const meta = (angle?.metadata ?? {}) as Record<string, unknown>;
  console.log("\n=== ANGLE metadata.provenance ===");
  console.log(JSON.stringify(meta.provenance ?? null, null, 2).slice(0, 2000));
  console.log("\n=== ANGLE metadata keys ===", Object.keys(meta).join(", "));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
