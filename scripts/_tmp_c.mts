const U=process.env.NEXT_PUBLIC_SUPABASE_URL, K=process.env.SUPABASE_SERVICE_ROLE_KEY;
const h={apikey:K!,Authorization:`Bearer ${K}`};
const r=await fetch(`${U}/rest/v1/agent_jobs?select=id,status,spec_slug,created_at&kind=eq.pr-resolve&log_tail=ilike.*Refusing%20automatic%20closure*&order=created_at.desc&limit=40`,{headers:h});
const js=await r.json(); console.log(js.length); for(const j of js) console.log(j.created_at.slice(0,10),j.status,j.spec_slug);
