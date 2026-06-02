import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TICKET = "32a6eed8-ae74-48a2-9123-03bccc7502b6";
async function main() {
  const { data: t } = await admin.from("tickets").select("*").eq("id", TICKET).single();
  console.log("subject:", t.subject, "·", t.status, "· tags:", t.tags);
  const { data: msgs } = await admin.from("ticket_messages")
    .select("direction, author_type, body, body_clean, created_at, visibility")
    .eq("ticket_id", TICKET).order("created_at", { ascending: true });
  for (const m of msgs || []) {
    const body = (m.direction === "inbound" ? (m.body_clean || m.body) : (m.body || "")).slice(0, 1500).replace(/\n+/g, " ");
    console.log(`\n[${m.direction} · ${m.author_type} · ${m.visibility || "external"}]\n  ${body}`);
  }
}
main();
