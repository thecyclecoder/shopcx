const U=process.env.NEXT_PUBLIC_SUPABASE_URL, K=process.env.SUPABASE_SERVICE_ROLE_KEY;
const h={apikey:K!,Authorization:`Bearer ${K}`};
const r=await fetch(`${U}/rest/v1/agent_jobs?select=id,status,created_at,updated_at,error,instructions&kind=eq.build&spec_slug=eq.ai-shopping-agent-mcp&order=created_at`,{headers:h});
for(const j of await r.json()) console.log(j.id.slice(0,8),j.status,j.created_at.slice(5,16),j.updated_at.slice(5,16),(j.error??"").slice(-400).replace(/\n/g," "),"\n   instr:",(j.instructions??"").slice(0,200).replace(/\n/g," "));
