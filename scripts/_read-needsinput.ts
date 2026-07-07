import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("agent_jobs").select("id,kind,status,spec_slug,questions,answers,session_note,log_tail,created_at")
    .eq("kind","build").eq("spec_slug","refund-idempotency-guard-in-commerce-refund-facade")
    .order("created_at",{ascending:false}).limit(2);
  for(const j of data||[]){
    console.log(`job ${j.id}  status=${j.status}  created=${new Date(j.created_at).toISOString().slice(11,19)}`);
    console.log("QUESTIONS:", JSON.stringify(j.questions,null,2));
    if(j.answers) console.log("(already answered:", JSON.stringify(j.answers),")");
    if(j.session_note) console.log("session_note:", j.session_note);
    if(j.log_tail) console.log("log_tail:", String(j.log_tail).slice(-600));
    console.log("────");
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
