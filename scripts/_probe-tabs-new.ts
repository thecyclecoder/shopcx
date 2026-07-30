import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
const V="v21.0";
(async()=>{
  const admin=createAdminClient();
  const {data:ws}=await admin.from("workspaces").select("id").limit(20);
  let token:string|null=null; for(const w of ws??[]){token=await getMetaUserToken(w.id); if(token)break;}
  console.log("token?", !!token);
  const u=new URL(`https://graph.facebook.com/${V}/act_196487894712827/adsets`);
  u.searchParams.set("fields","id,name,created_time,effective_status");
  u.searchParams.set("limit","200");
  u.searchParams.set("access_token",token!);
  const j:any=await (await fetch(u)).json();
  console.log("keys:", Object.keys(j), "n=", j.data?.length, "err=", JSON.stringify(j.error ?? null));
  const rows=(j.data??[]).map((s:any)=>({t:(s.created_time??"").slice(0,10),n:String(s.name).slice(0,46),st:s.effective_status}))
    .sort((a:any,b:any)=>b.t.localeCompare(a.t)).slice(0,10);
  for(const r of rows) console.log(`${r.t}  ${String(r.st).padEnd(9)} ${r.n}`);
})();
