/**
 * Migrate the brand's Privacy Policy + Terms of Service off the Shopify site
 * into our `policies` table (slugs `privacy` + `terms`) so the storefront
 * footer is sunset-proof. Idempotent: re-running updates the active row.
 *   npx tsx scripts/migrate-legal-policies.ts [--commit]
 */
import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const COMMIT = process.argv.includes("--commit");

function strip(s:string){ return s.replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim(); }
function decode(s:string){ const m:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",mdash:"—",ndash:"–",hellip:"…",rsquo:"’",lsquo:"‘",rdquo:"”",ldquo:"“",copy:"©",reg:"®",trade:"™"};
  return s.replace(/&([a-z]+);/gi,(x,n)=>m[n.toLowerCase()]??x).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16))); }
function htmlToMd(html:string){
  let s = html.replace(/<!--[\s\S]*?-->/g,"").replace(/<(script|style)[\s\S]*?<\/\1>/gi,"");
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_,h,t)=>`[${strip(t)}](${h})`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,(_,__,t)=>`**${strip(t)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,(_,__,t)=>`*${strip(t)}*`);
  s = s.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi,(_,t)=>`\n\n# ${strip(t)}\n\n`);
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi,(_,t)=>`\n\n## ${strip(t)}\n\n`);
  s = s.replace(/<h[3-6]\b[^>]*>([\s\S]*?)<\/h[3-6]>/gi,(_,t)=>`\n\n### ${strip(t)}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi,(_,t)=>`\n- ${strip(t)}`);
  s = s.replace(/<\/(ul|ol)>/gi,"\n\n").replace(/<(ul|ol)\b[^>]*>/gi,"\n");
  s = s.replace(/<\/p>/gi,"\n\n").replace(/<p\b[^>]*>/gi,"").replace(/<br\s*\/?>/gi,"\n");
  s = s.replace(/<[^>]+>/g,"");
  s = decode(s).replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").replace(/[ \t]{2,}/g," ").trim();
  return s;
}
async function fetchPolicy(slug:string){
  const html = await (await fetch(`https://superfoodscompany.com/policies/${slug}`)).text();
  const bi = html.indexOf("shopify-policy__body"); if(bi<0) return null;
  const rs = html.indexOf('<div class="rte">', bi); const end = html.indexOf("</main>", rs);
  const inner = html.slice(html.indexOf(">", rs)+1, end<0?undefined:end);
  return htmlToMd(inner);
}
(async()=>{
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: ws } = await admin.from("workspaces").select("id").eq("name","Superfoods Company").single();
  const items = [
    { src:"privacy-policy", slug:"privacy", name:"Privacy Policy" },
    { src:"terms-of-service", slug:"terms", name:"Terms & Conditions" },
  ];
  for (const it of items){
    const md = await fetchPolicy(it.src);
    if(!md){ console.log(`  ${it.slug}: FETCH FAILED`); continue; }
    console.log(`  ${it.slug}: ${md.length} chars markdown | head: ${md.slice(0,70).replace(/\n/g," ")}`);
    if(!COMMIT) continue;
    const row = { workspace_id: ws!.id, slug: it.slug, name: it.name, version:1, effective_at:new Date().toISOString(),
      customer_summary: md, internal_summary: `${it.name} — imported from the Shopify storefront (sunset-proofing). Customer-facing legal text.`,
      rules: [], is_active:true, superseded_by:null, updated_at:new Date().toISOString() };
    const { data: existing } = await admin.from("policies").select("id").eq("workspace_id",ws!.id).eq("slug",it.slug).eq("is_active",true).is("superseded_by",null).maybeSingle();
    if(existing){ await admin.from("policies").update(row).eq("id",existing.id); console.log(`    updated existing ${existing.id}`); }
    else { const { error } = await admin.from("policies").insert(row); console.log(error?`    INSERT ERR: ${error.message}`:`    inserted`); }
  }
  console.log(COMMIT?"done":"(dry run — pass --commit)");
})().catch(e=>{console.error(e);process.exit(1);});
