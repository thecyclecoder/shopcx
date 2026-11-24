const U=process.env.NEXT_PUBLIC_SUPABASE_URL, K=process.env.SUPABASE_SERVICE_ROLE_KEY;
const h={apikey:K!,Authorization:`Bearer ${K}`};
const g=async(q:string)=>{const r=await fetch(`${U}/rest/v1/${q}`,{headers:h});return r.json();};
const j=(await g(`agent_jobs?select=log_tail&id=like.0fcb4fb3*`));
console.log((await g(`agent_jobs?select=log_tail,instructions&kind=eq.pr-resolve&spec_slug=eq.pr-3793`))[0]?.log_tail?.slice(-1500));
console.log("== notifs");
for (const n of await g(`dashboard_notifications?select=id,type,title,body,metadata,created_at&read=eq.false&dismissed=eq.false&order=created_at.desc&limit=3`)) console.log(JSON.stringify(n).slice(0,1500),"\n");
console.log("== dbhealth");
console.log((await g(`agent_jobs?select=log_tail,instructions,pending_actions&kind=eq.db_health&status=eq.needs_approval`)));
