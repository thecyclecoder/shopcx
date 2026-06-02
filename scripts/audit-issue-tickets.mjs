import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const ISSUES = [
  { tid: "8a5dd958-5a3d-4de9-b2fc-caf9aa601dce", flag: "#1 generic error to urgent billing" },
  { tid: "b99c9fec-a387-404c-b31b-2bff4494623c", flag: "#4 promised account access, didn't deliver" },
  { tid: "9bfce5c2-0e91-429a-806a-93054ef7d195", flag: "#15 'linking now' cut off mid-sentence" },
  { tid: "fadb5f01-7d7f-499e-af21-a144145d4e06", flag: "#18 frustrated, AI not reading emails" },
  { tid: "9f53fde5-6164-428c-9805-6a4aa5624a29", flag: "#20 testimonial when wanted qty change" },
  { tid: "b41d2729-ceba-4a9b-aefe-c5d9fcfda508", flag: "#23 wrong date Apr 1 vs Apr 29" },
  { tid: "61ca5299-a15f-4fe8-8348-cd651b8e668a", flag: "#24 frequency contradiction" },
  { tid: "528f6ed9-66fb-47c3-be28-eea76a7bd957", flag: "#27 wrong sub start date (Marlene — already handled)" },
  { tid: "0ef4a608-340d-455c-8216-310d80088b39", flag: "#29 'July 25 expires tomorrow' wrong" },
];

for (const { tid, flag } of ISSUES) {
  const { data: t } = await admin.from("tickets")
    .select("subject, status, customer_id, escalated_to, assigned_to, agent_intervened")
    .eq("id", tid).single();
  const { data: cust } = t?.customer_id ? await admin.from("customers").select("first_name, email").eq("id", t.customer_id).single() : { data: null };

  const { data: msgs } = await admin.from("ticket_messages")
    .select("created_at, author_type, visibility, body")
    .eq("ticket_id", tid).order("created_at", { ascending: false }).limit(8);
  const recent = (msgs || []).reverse();

  console.log(`\n══ ${flag}`);
  console.log(`   ${tid}  status=${t?.status}  agent=${t?.agent_intervened}  assigned=${t?.assigned_to ? "yes" : "no"}  escalated=${t?.escalated_to ? "yes" : "no"}`);
  console.log(`   ${cust?.first_name || "?"} <${cust?.email || "?"}>  subject: ${t?.subject?.slice(0,80)}`);
  console.log("   last 4 messages:");
  for (const m of recent.slice(-4)) {
    const txt = (m.body || "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim();
    console.log(`     ${m.created_at?.slice(11,19)} ${m.author_type} ${m.visibility === "internal" ? "[int]" : ""}: ${txt.slice(0, 200)}`);
  }
}
