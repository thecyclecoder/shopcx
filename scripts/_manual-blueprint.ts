import { loadEnv } from "./_bootstrap";
loadEnv();
import { createClient } from "@supabase/supabase-js";
import { adaptSkeletonFromTeardown } from "../src/lib/cleo-blueprint";
import { createBlueprint } from "../src/lib/lander-blueprints";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const AMAZING = "ea433e56-0aa4-4b46-9107-feb11f77f533"; // Amazing Coffee
const TD = "30838200-c0c0-43eb-8635-1a4a24679597"; // learn.erthlabs.co/reasons2 (ad_count 11)

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: row } = await sb.from("research_urls").select("teardown").eq("id", TD).single();
  const recipe = row!.teardown as any;
  const skeleton = adaptSkeletonFromTeardown(recipe);
  const bp = await createBlueprint({
    workspace_id: WS, product_id: AMAZING, research_url_id: TD,
    funnel_type: recipe.funnel_type,
    skeleton,
    rationale: "CEO manual: Erth /reasons advertorial-listicle → Amazing Coffee (direct superfood-coffee competitor; we have no dedicated presell advertorial lander — build-new).",
    created_by: "ceo-manual",
  });
  await sb.from("agent_jobs").insert({
    workspace_id: WS, spec_slug: bp.id, kind: "dr-content", status: "queued", created_by: null,
    instructions: `Write DR content for lander_blueprint ${bp.id}. Read the blueprint's skeleton, fill copy per block via setBlueprintContent, generate the generatable imagery + flag real-asset gaps, then advance status to content_complete (or awaiting_upload if assets are needed).`,
  });
  // Stop the buggy sweep from re-creating garbage: mark ALL teardowns reviewed until the matching hotfix lands.
  const { data: rst } = await sb.from("research_urls").update({ growth_reviewed_at: new Date().toISOString() }).not("teardown", "is", null).select("id");
  console.log(JSON.stringify({ blueprint_id: bp.id, funnel_type: recipe.funnel_type, skeleton_blocks: skeleton.blocks?.length, teardowns_parked: rst?.length }, null, 2));
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
