import { loadEnv } from "./_bootstrap";
loadEnv();
import { createClient } from "@supabase/supabase-js";
import { setBlueprintStatus } from "../src/lib/lander-blueprints";
import { verifyAndSubmitBlueprint } from "../src/lib/blueprint-build-submit";
import fs from "node:fs";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const AMAZING = "ea433e56-0aa4-4b46-9107-feb11f77f533";
const BP = "23e0ea01-fea1-4aa2-90f3-bad2d856f654";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function uploadMedia(localPath: string, ext: string, mime: string, slot: string, category: string, source: string, alt: string): Promise<string> {
  const buf = fs.readFileSync(localPath);
  const ts = Date.now();
  const path = `workspaces/${WS}/products/${AMAZING}/uploads/${slot}-${ts}.${ext}`;
  const { error: upErr } = await sb.storage.from("product-media").upload(path, buf, { contentType: mime, upsert: true });
  if (upErr) throw new Error(`storage(${slot}): ${upErr.message}`);
  const { data: pub } = sb.storage.from("product-media").getPublicUrl(path);
  const { data: media, error: mErr } = await sb.from("product_media")
    .insert({ workspace_id: WS, product_id: AMAZING, slot, url: pub.publicUrl, storage_path: path, category, source, alt_text: alt })
    .select("id").single();
  if (mErr) throw new Error(`media(${slot}): ${mErr.message}`);
  return media!.id as string;
}

async function main() {
  const badgeId = await uploadMedia(
    "/private/tmp/claude-501/-Users-admin-Projects-shopcx/60367958-34d7-4deb-87f6-6a78358e5fab/scratchpad/trust-badges.jpg",
    "jpg", "image/jpeg", "trust_badges", "press_logo", "generated", "Non-GMO, 3rd-Party Tested, Made in USA trust badges");
  const selfieId = await uploadMedia(
    `${process.env.HOME}/.claude/image-cache/60367958-34d7-4deb-87f6-6a78358e5fab/3.png`,
    "png", "image/png", "ugc_1", "ugc", "uploaded", "Real customer holding Amazing Coffee with an iced coffee in her kitchen");
  console.log("uploaded → badges:", badgeId.slice(0,8), "selfie:", selfieId.slice(0,8));

  // resolve the 2 open gaps
  const { data: open } = await sb.from("lander_content_gaps").select("id,description").eq("blueprint_id", BP).eq("status", "open");
  for (const g of (open || [])) {
    const isBadge = /badge|certif|non-gmo|3rd|tested|made in/i.test(g.description);
    await sb.from("lander_content_gaps").update({ status: "resolved", resolved_media_id: isBadge ? badgeId : selfieId, updated_at: new Date().toISOString() }).eq("id", g.id);
    console.log(`  resolved ${isBadge ? "cert-badge" : "ugc"} gap`);
  }

  // all gaps resolved → content_complete → verify + submit build
  await setBlueprintStatus(WS, BP, "content_complete");
  const outcome = await verifyAndSubmitBlueprint(WS, BP);
  console.log("SUBMIT OUTCOME:", JSON.stringify(outcome));
  const { data: bp } = await sb.from("lander_blueprints").select("status,build_spec_slug").eq("id", BP).single();
  console.log("blueprint FINAL:", bp!.status, "| build spec:", bp!.build_spec_slug);
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
