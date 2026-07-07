import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data:notes}=await a.from("dashboard_notifications")
    .select("id,title,body,metadata,created_at")
    .eq("type","agent_approval_request").eq("dismissed",false)
    .order("created_at",{ascending:true}).limit(200);
  const plans=(notes||[]).filter(n=>{const m=n.metadata as any;return (m?.kind==='plan')||/^plan:/.test(n.title||"");});
  console.log(`kind=plan approvals: ${plans.length}\n`);
  for(const n of plans){
    const m=n.metadata as any; const spec=m?.spec||m?.action?.spec||m?.pending_action?.spec||null;
    console.log("──────────────────────────────────────────");
    console.log("TITLE:", n.title);
    if(spec){
      console.log(`  slug=${spec.slug}  owner=${spec.owner}  milestone=${spec.milestone}  parent="${spec.parent}"`);
      if(spec.blocked_by?.length) console.log(`  blocked_by: ${JSON.stringify(spec.blocked_by)}`);
      console.log(`  intent: ${(spec.intent||'').slice(0,400)}`);
      if(spec.gap) console.log(`  gap: ${(spec.gap||'').slice(0,200)}`);
    } else {
      console.log("  (no spec in metadata) metadata keys:", Object.keys(m||{}));
      console.log("  body:", (n.body||'').slice(0,300));
    }
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
