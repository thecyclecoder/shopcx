/**
 * Fraud FP 3e1e138c — Linda West. Portal ticket 09efff1a was created when she hit
 * account_restricted errors (the erroneous ban). She's now un-banned, her subs are
 * reactivated, and her order was re-placed (SC132899). Proactively reassure her: our
 * system erred and cancelled her order, it's fixed, ships on time. No mention of fraud.
 * Then close + unassign the ticket.
 *
 * Run with --exec to send; default prints the body without sending.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const EXEC = process.argv.includes("--exec");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "09efff1a-a902-4701-bca6-58b143f814be";
const TO = "wslinda1@netscape.net";
const SUBJECT = "Re: Your Superfood Tabs order — all fixed";

const body = [
  "<p>Hi Linda,</p>",
  "<p>I owe you an apology — a glitch on our end accidentally cancelled your recent Superfood Tabs order.</p>",
  "<p>I've already fixed it and put your order back through, so it's all set to ship out on time. There's nothing you need to do on your end.</p>",
  "<p>Thanks so much for your patience, and sorry again for the mix-up. Just reply here if you need anything at all.</p>",
  "<p>Dylan<br>Superfoods Company</p>",
].join("");

async function main() {
  if (!EXEC) {
    console.log("DRY RUN — would send to", TO, "\nSubject:", SUBJECT, "\n\n" + body.replace(/<\/p>/g, "\n").replace(/<[^>]+>/g, ""));
    console.log("Pass --exec to send + close.");
    return;
  }
  const { sendTicketReply } = await import("../src/lib/email");
  console.log("Sending to", TO, "…");
  const { messageId, error } = await sendTicketReply({
    workspaceId: WS, toEmail: TO, subject: SUBJECT, body,
    inReplyTo: null, agentName: "Dylan", workspaceName: "Superfoods Company",
  });
  if (error || !messageId) throw new Error(`send failed: ${error}`);
  console.log("  ✓ sent, resend id:", messageId);

  const { error: insErr } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET, direction: "outbound", visibility: "external", author_type: "agent",
    body, resend_email_id: messageId, sent_at: new Date().toISOString(),
  });
  if (insErr) throw new Error(`message insert failed: ${insErr.message}`);
  console.log("  ✓ outbound message persisted");

  const { error: updErr } = await admin.from("tickets").update({
    assigned_to: null, status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", TICKET);
  if (updErr) throw new Error(`ticket update failed: ${updErr.message}`);
  console.log("  ✓ ticket closed + unassigned");

  const { data: check } = await admin.from("tickets").select("status, assigned_to, closed_at").eq("id", TICKET).single();
  console.log("\nfinal ticket state:", JSON.stringify(check));
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
