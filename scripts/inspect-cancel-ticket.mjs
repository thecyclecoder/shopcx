// Inspect the ticket where AI tried to save instead of routing to cancel journey
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "/Users/admin/Projects/shopcx/scripts/env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TID = "cd1d8774-8645-4472-954e-f0b42301eb8b";

const { data: t } = await admin.from("tickets")
  .select("id, subject, status, tags, ai_turn_count, channel, customer_id, workspace_id, created_at, handled_by, assigned_to")
  .eq("id", TID).single();

console.log("─── TICKET ───");
console.log(JSON.stringify(t, null, 2));

const { data: msgs } = await admin.from("ticket_messages")
  .select("created_at, direction, author_type, visibility, body_clean, body")
  .eq("ticket_id", TID).order("created_at", { ascending: true });

console.log(`\n─── MESSAGES (${msgs?.length || 0}) ───`);
for (const m of msgs || []) {
  const time = new Date(m.created_at).toLocaleString();
  const role = m.author_type || m.direction;
  const vis = m.visibility === "internal" ? "[internal]" : "";
  const txt = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\n${time} ${role} ${vis}`);
  console.log(`  ${txt.slice(0, 800)}${txt.length > 800 ? "...(trunc)" : ""}`);
}
