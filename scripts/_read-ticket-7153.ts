import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const TID="71538c70-af8d-4cac-8e81-62cda163f49a";
(async () => {
  const db = createAdminClient();
  const { data: t } = await db.from("tickets").select("*").eq("id",TID).maybeSingle();
  if(!t){console.log("not found");process.exit(0);}
  console.log("=== TICKET ===");
  console.log("subject:", (t as any).subject, "| status:", (t as any).status, "| channel:", (t as any).channel);
  console.log("tags:", JSON.stringify((t as any).tags), "| customer:", (t as any).customer_id);
  console.log("\n=== MESSAGES ===");
  const { data: msgs } = await db.from("ticket_messages").select("*").eq("ticket_id",TID).order("created_at",{ascending:true});
  for (const m of msgs||[]) {
    const who=(m as any).direction||(m as any).author_type;
    const body=((m as any).body??"").toString().replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
    console.log(`\n[${(m as any).created_at?.slice(5,16)}] ${who} ${(m as any).author_type} ${(m as any).visibility||""}`);
    console.log("  "+body.slice(0,700));
  }
  console.log("\n=== TICKET_ANALYSES ===");
  const { data: an } = await db.from("ticket_analyses").select("*").eq("ticket_id",TID).order("created_at",{ascending:true});
  for (const a of an||[]) {
    console.log(`\n[${(a as any).created_at?.slice(5,16)}] score=${(a as any).score} ai_msgs=${(a as any).ai_message_count}`);
    console.log("  summary:", (a as any).summary);
    if((a as any).issues) console.log("  issues:", JSON.stringify((a as any).issues).slice(0,500));
    for (const k of Object.keys(a||{})) if(/reason|detail|analysis|recommend|verdict/i.test(k)&&(a as any)[k]) console.log("  ."+k+":", JSON.stringify((a as any)[k]).slice(0,400));
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
