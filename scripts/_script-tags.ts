import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
/**
 * List (and optionally delete) Shopify ScriptTags for a workspace.
 *
 * Shopify exposes no admin UI for ScriptTags, so an app that uninstalls badly can
 * leave one injecting a script into every page of the store indefinitely. Needs
 * read_script_tags / write_script_tags — see SHOPIFY_SCOPES in src/lib/shopify.ts.
 *
 *   npx tsx scripts/_script-tags.ts                 # list
 *   npx tsx scripts/_script-tags.ts --delete <id>   # remove one
 */
const WS = process.env.WS_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const a=createAdminClient();
  const { data } = await a.from("workspaces")
    .select("shopify_access_token_encrypted, shopify_myshopify_domain").eq("id",WS).single();
  const shop=data!.shopify_myshopify_domain, token=decrypt(data!.shopify_access_token_encrypted);
  const H={ "X-Shopify-Access-Token": token, "Content-Type":"application/json" };

  const del = process.argv.indexOf("--delete");
  if(del>=0){
    const id=process.argv[del+1];
    if(!id) throw new Error("--delete needs a ScriptTag id");
    const r = await fetch(`https://${shop}/admin/api/2025-07/script_tags/${id}.json`,{method:"DELETE",headers:H});
    console.log(r.ok ? `deleted ${id}` : `failed ${r.status}: ${(await r.text()).slice(0,200)}`);
    return;
  }
  const r = await fetch(`https://${shop}/admin/api/2025-07/script_tags.json?limit=250`,{headers:H});
  const j:any = await r.json();
  if(j.errors){ console.log("ERR", JSON.stringify(j.errors).slice(0,240)); return; }
  const tags=j.script_tags||[];
  console.log(`${tags.length} ScriptTag(s) on ${shop}:`);
  for (const t of tags) console.log(`  [${t.id}] ${t.event}/${t.display_scope}  created ${String(t.created_at).slice(0,10)}\n        ${t.src}`);
}
main().catch(e=>{console.error("ERR",String(e).slice(0,300));process.exit(1);});
