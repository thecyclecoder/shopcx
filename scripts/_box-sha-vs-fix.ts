import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { execSync } from "node:child_process";
(async()=>{
  const db=createAdminClient();
  const { data } = await db.from("worker_heartbeats").select("running_sha,updated_at").eq("id","box").maybeSingle();
  const sha=(data as any)?.running_sha;
  let live=false; try{ execSync("git fetch origin main -q",{stdio:"ignore"}); execSync(`git merge-base --is-ancestor b595a976 ${sha}`,{stdio:"ignore"}); live=true;}catch{}
  console.log(`box running_sha=${sha} updated=${(data as any)?.updated_at} | #1791-live-on-box=${live}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
