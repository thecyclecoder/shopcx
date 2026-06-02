// Delete imported Gorgias outbound agent replies on a ticket so
// Sonnet doesn't see them as part of conversation history.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TICKET_ID = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!TICKET_ID || TICKET_ID.startsWith("--")) {
  console.error("Usage: node delete-gorgias-replies.mjs <ticket-uuid> [--apply]");
  process.exit(1);
}

const { data: msgs } = await admin
  .from("ticket_messages")
  .select("id, direction, author_type, visibility, body_clean, body, created_at")
  .eq("ticket_id", TICKET_ID)
  .eq("direction", "outbound")
  .eq("author_type", "agent")
  .eq("visibility", "external");

console.log(`Found ${msgs?.length || 0} outbound agent message(s) on this ticket:\n`);
for (const m of msgs || []) {
  const body = (m.body_clean || (m.body || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  console.log(`  ${m.id}  ${m.created_at?.slice(0, 16)}`);
  console.log(`    "${body.slice(0, 200)}${body.length > 200 ? "…" : ""}"`);
}

if (!APPLY) { console.log("\nDry run — re-run with --apply to delete"); process.exit(0); }

if (!msgs?.length) { console.log("Nothing to delete."); process.exit(0); }

const { error } = await admin
  .from("ticket_messages")
  .delete()
  .in("id", msgs.map(m => m.id));
if (error) console.log(`✗ ${error.message}`);
else {
  await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] Operator removed ${msgs.length} imported Gorgias agent reply/replies before re-triggering Sonnet — keeps the conversation context clean.`,
  });
  console.log(`\n✓ deleted ${msgs.length} message(s)`);
}
