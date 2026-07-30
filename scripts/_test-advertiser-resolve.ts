import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
async function resolve(q:string){
  const r=await fetch(`${BASE}/api/advertisers/search?q=${encodeURIComponent(q)}&country=US`,{headers:{Authorization:`Bearer ${KEY}`}});
  if(!r.ok) return `HTTP ${r.status}`;
  const j:any=await r.json();
  const m=j.best_match?.meta || j.candidates?.meta?.[0];
  return m ? `meta pageId=${m.id} name="${m.name}" likes=${m.likes??"?"} verified=${m.verified??"?"} (best_match conf=${j.best_match?.confidence??"-"})` : `NO meta match (candidates.meta=${(j.candidates?.meta||[]).length})`;
}
(async()=>{
  for(const q of ["Obvi","Calm","Magic Mind","AG1"]){ console.log(`${q}: ${await resolve(q)}`); await new Promise(r=>setTimeout(r,7000)); }
})().then(()=>process.exit(0));
