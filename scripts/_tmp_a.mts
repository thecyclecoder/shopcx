const U=process.env.NEXT_PUBLIC_SUPABASE_URL, K=process.env.SUPABASE_SERVICE_ROLE_KEY;
const h={apikey:K!,Authorization:`Bearer ${K}`};
const g=async(q:string)=>{const r=await fetch(`${U}/rest/v1/${q}`,{headers:h});return r.json();};
console.log("== open jobs");
for(const j of await g(`agent_jobs?select=id,kind,status,spec_slug,created_at,updated_at,log_tail,error&status=not.in.(completed,merged,failed,cancelled,superseded,rejected)&order=created_at`)) console.log(j.id.slice(0,8),j.kind,j.status,j.spec_slug,j.created_at.slice(5,16),j.updated_at.slice(5,16),((j.error??"")+" | "+(j.log_tail??"")).slice(-200).replace(/\n/g," "));
console.log("== failed last 48h");
for(const j of await g(`agent_jobs?select=id,kind,status,spec_slug,updated_at,error&status=eq.failed&updated_at=gte.2026-11-22T19:00:00Z&order=updated_at`)) console.log(j.id.slice(0,8),j.kind,j.spec_slug,j.updated_at.slice(5,16),(j.error??"").slice(-160).replace(/\n/g," "));
console.log("== unread dashboard notifications");
const n=await g(`dashboard_notifications?select=id,type,title,created_at&read=eq.false&dismissed=eq.false&order=created_at.desc&limit=40`); console.log(Array.isArray(n)?n.map((x:any)=>`${x.created_at.slice(5,16)} ${x.type} ${x.title}`).join("\n"):n);
