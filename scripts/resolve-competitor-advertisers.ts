/**
 * winners-flow Phase 1 — resolve every approved competitor to its Meta advertiser Page ID and persist it
 * (competitors.meta_page_id …). Ladder: brand-name resolve (highest-likes name match) → domain fallback.
 * Throttled 7s to respect AdLibrary's 10-req/min cap. Read-mostly (writes only the meta_* columns via the
 * SDK). Run: `npx tsx scripts/resolve-competitor-advertisers.ts [workspaceId]`. Eventually a cron / on-approval.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { setCompetitorMetaResolution } from "../src/lib/competitors";
import { resolveAdvertiser } from "../src/lib/adlibrary-winners";

const WS = process.argv[2] || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data: comps } = await admin
    .from("competitors")
    .select("id, brand, search_keyword, domain, product_id")
    .eq("workspace_id", WS)
    .neq("status", "rejected");
  const rows = comps ?? [];
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const c of rows as Array<{ id: string; brand: string; search_keyword: string | null; domain: string | null }>) {
    const term = c.search_keyword || c.brand;
    const r = await resolveAdvertiser(term, { domain: c.domain });
    await setCompetitorMetaResolution(
      c.id,
      { meta_page_id: r.pageId, meta_resolved_name: r.name, meta_likes: r.likes, meta_resolved_via: r.via },
      { workspaceId: WS },
    );
    if (r.pageId) resolved.push(`✅ "${term}" → pageId=${r.pageId} "${r.name}" (${r.likes ?? "?"} likes, via ${r.via})`);
    else unresolved.push(`⚠️ "${term}" — UNRESOLVED (no name/domain match — bad seed)`);
    await new Promise((res) => setTimeout(res, 7000));
  }
  console.log(`\n===== ${resolved.length} resolved · ${unresolved.length} unresolved =====\n`);
  console.log(resolved.join("\n"));
  if (unresolved.length) console.log("\n" + unresolved.join("\n"));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
