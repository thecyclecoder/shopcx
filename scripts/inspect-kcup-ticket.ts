/**
 * Pull the conversation + cost breakdown for the K-cups question
 * ticket the user flagged.
 */
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
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TICKET_ID = "39625080-80f0-4565-8954-83f6e43694e9";

async function main() {
  // Ticket header
  const { data: ticket } = await admin
    .from("tickets")
    .select("*")
    .eq("id", TICKET_ID)
    .single();
  console.log("=== TICKET ===");
  console.log({
    id: ticket?.id,
    subject: ticket?.subject,
    channel: ticket?.channel,
    status: ticket?.status,
    handled_by: ticket?.handled_by,
    ai_turn_count: ticket?.ai_turn_count,
    escalation_reason: ticket?.escalation_reason,
    agent_intervened: ticket?.agent_intervened,
    tags: ticket?.tags,
    created_at: ticket?.created_at,
  });

  // Messages
  const { data: msgs } = await admin
    .from("ticket_messages")
    .select("direction, visibility, author_type, body_clean, body, created_at, macro_id")
    .eq("ticket_id", TICKET_ID)
    .order("created_at", { ascending: true });
  console.log(`\n=== MESSAGES (${msgs?.length || 0}) ===`);
  for (const m of msgs || []) {
    const body = m.body_clean || m.body || "";
    console.log(`\n[${m.created_at}] ${m.direction}/${m.visibility} (${m.author_type})`);
    console.log("  " + body.replace(/<[^>]+>/g, "").slice(0, 500).replace(/\n/g, " "));
  }

  // Cost / token usage
  const { data: tokens } = await admin
    .from("ai_token_usage")
    .select("*")
    .eq("ticket_id", TICKET_ID)
    .order("created_at", { ascending: true });
  console.log(`\n=== AI TOKEN USAGE (${tokens?.length || 0} calls) ===`);
  let totalIn = 0, totalOut = 0, totalCache = 0, totalCacheRead = 0;
  for (const t of tokens || []) {
    totalIn += t.input_tokens || 0;
    totalOut += t.output_tokens || 0;
    totalCache += t.cache_creation_tokens || 0;
    totalCacheRead += t.cache_read_tokens || 0;
    console.log(
      `${t.created_at}  purpose=${t.purpose}  model=${t.model}  in=${t.input_tokens} out=${t.output_tokens} cache_create=${t.cache_creation_tokens} cache_read=${t.cache_read_tokens}`,
    );
  }
  console.log(`\nTOTALS: input=${totalIn} output=${totalOut} cache_create=${totalCache} cache_read=${totalCacheRead}`);

  // Rough cost (Sonnet 4 rates approx): input $3/MTok, output $15/MTok, cache write $3.75, cache read $0.30
  // Haiku rates: input $0.80/MTok, output $4/MTok
  // We don't know model split here without examining each row, just print totals
}

main().catch((e) => { console.error(e); process.exit(1); });
