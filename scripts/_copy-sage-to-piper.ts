import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{const db=createAdminClient();
const { data, error } = await db.storage.from("agent-avatars").download("sage-playbook-compiler.jpg");
if(error||!data){console.log("download err:",error?.message);process.exit(1);}
const buf=Buffer.from(await data.arrayBuffer());
const { error: uErr } = await db.storage.from("agent-avatars").upload("piper-playbook-compiler.jpg", buf, { contentType:"image/jpeg", upsert:true });
console.log(uErr? "upload err:"+uErr.message : "✓ piper-playbook-compiler.jpg uploaded (copied from sage)");
process.exit(0);})();
