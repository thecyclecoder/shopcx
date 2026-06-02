import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TICKET_ID = "361e4b72-9604-4dfe-8b85-eea926f9a026";

async function main() {
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, channel, status, handled_by, ai_turn_count, escalation_reason, tags, customer_id, workspace_id")
    .eq("id", TICKET_ID)
    .single();
  console.log("=== TICKET ===");
  console.log(ticket);

  const { data: msgs } = await admin
    .from("ticket_messages")
    .select("direction, visibility, author_type, body_clean, body, created_at")
    .eq("ticket_id", TICKET_ID)
    .order("created_at", { ascending: true });
  console.log(`\n=== MESSAGES (${msgs?.length || 0}) ===`);
  for (const m of msgs || []) {
    const body = (m.body_clean || m.body || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    console.log(`\n[${m.created_at}] ${m.direction}/${m.visibility} (${m.author_type})`);
    console.log("  " + body.slice(0, 700));
  }

  // Now look for ANY content that mentions same-day / void / refund rules
  const wsId = ticket?.workspace_id;
  if (wsId) {
    console.log("\n\n=== SEARCH: macros mentioning void / same-day / same day refund ===");
    const { data: macros } = await admin
      .from("macros")
      .select("name, category, body_text, body_html")
      .eq("workspace_id", wsId);
    for (const m of macros || []) {
      const text = ((m.body_text || "") + " " + (m.body_html || "")).toLowerCase();
      if (/void|same.day|same day/.test(text) && /refund/.test(text)) {
        console.log(`\n— Macro: [${m.category}] ${m.name}`);
        console.log("  " + (m.body_text || m.body_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400));
      }
    }

    console.log("\n\n=== SEARCH: sonnet_prompts mentioning void / same-day / refund ===");
    const { data: prompts } = await admin
      .from("sonnet_prompts")
      .select("title, category, content")
      .eq("workspace_id", wsId);
    for (const p of prompts || []) {
      const t = (p.content || "").toLowerCase();
      if (/void|same.day|same day/.test(t) && /refund/.test(t)) {
        console.log(`\n— Prompt: [${p.category}] ${p.title}`);
        console.log("  " + (p.content || "").slice(0, 500));
      }
    }

    console.log("\n\n=== SEARCH: KB chunks mentioning void / same-day refund ===");
    const { data: chunks } = await admin
      .from("kb_chunks")
      .select("kb_title, chunk_text")
      .eq("workspace_id", wsId);
    for (const k of chunks || []) {
      const t = (k.chunk_text || "").toLowerCase();
      if (/void/.test(t) || /same.day/.test(t)) {
        console.log(`\n— KB: ${k.kb_title}`);
        console.log("  " + (k.chunk_text || "").slice(0, 400));
      }
    }

    console.log("\n\n=== SEARCH: knowledge_base articles ===");
    const { data: kbs } = await admin
      .from("knowledge_base")
      .select("title, slug, content_html")
      .eq("workspace_id", wsId);
    for (const a of kbs || []) {
      const t = (a.content_html || "").toLowerCase();
      if (/void/.test(t) || /same.day refund/.test(t)) {
        console.log(`\n— Article: ${a.title} (/${a.slug})`);
        console.log("  " + (a.content_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400));
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
