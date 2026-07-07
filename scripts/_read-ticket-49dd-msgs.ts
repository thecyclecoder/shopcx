import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const TID = "49ddd6c4-9894-4474-b925-fffe19a175c8";
(async () => {
  const db = createAdminClient();
  const { data: msgs } = await db.from("ticket_messages").select("*").eq("ticket_id", TID).order("created_at", { ascending: true });
  console.log("=== MESSAGES (", (msgs||[]).length, ") ===");
  for (const m of msgs||[]) {
    const who = (m as any).sender_type || (m as any).direction || (m as any).author_type || "?";
    const body = ((m as any).body ?? (m as any).content ?? (m as any).text ?? "").toString().replace(/\s+/g," ").trim();
    console.log(`\n[${m.created_at}] ${who} ${(m as any).is_internal?"(internal)":""} ${(m as any).message_type?"["+(m as any).message_type+"]":""}`);
    console.log("   " + body.slice(0, 900));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
