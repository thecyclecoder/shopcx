import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
async function resolve(q:string){
  const r=await fetch(`${BASE}/api/advertisers/search?q=${encodeURIComponent(q)}&country=US`,{headers:{Authorization:`Bearer ${KEY}`}});
  if(!r.ok) return `HTTP ${r.status}`;
  const j:any=await r.json();
  const cands=(j.candidates?.meta||[]).slice(0,3).map((m:any)=>`"${m.name}"(${m.likes} likes, id=${m.id})`).join(" | ");
  return `best=${j.best_match?.meta?`"${j.best_match.meta.name}"(${j.best_match.meta.likes})`:"none"} · candidates: ${cands||"none"}`;
}
(async()=>{
  for(const q of ["MUD\\WTR","MUDWTR","mudwtr","MUD/WTR","MUD WTR"]){ console.log(`"${q}": ${await resolve(q)}`); await new Promise(r=>setTimeout(r,7000)); }
})().then(()=>process.exit(0));
