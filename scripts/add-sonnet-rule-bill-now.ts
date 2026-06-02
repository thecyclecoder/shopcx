/**
 * Teach Sonnet/Opus the bill_now primitive. The canary was Laura
 * Fenton (ticket 20a4b3c2) — she said "have it shipped asap" after
 * a reactivation, and Sonnet picked change_next_date with today's
 * date. Appstle rejected it ("Next billing date is invalid") and
 * the ticket bounced to a human.
 *
 * Right primitive: bill_now — Appstle's attemptBilling endpoint.
 * Charges the upcoming order today, no schedule manipulation.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const TITLE = "bill_now vs change_next_date — when to ship immediately";
const CONTENT = `When a customer asks to ship their subscription order RIGHT NOW ("ship asap", "send right away", "I'm out of product", "process my order today"), use \`bill_now\` — NOT \`change_next_date\` with today's date.

Why this matters: \`change_next_date\` to today (or any past date) is REJECTED by Appstle ("Next billing date is invalid"). The change_next_date handler now self-heals by falling back to bill_now in that case, but you should pick the right primitive up front.

bill_now action shape:
{ "type": "bill_now", "contract_id": "<sub contract id>" }

What it does: charges the customer's saved payment method against the upcoming order on the sub, processes it for fulfillment immediately. After the charge succeeds, Appstle advances next_billing_date by one cycle automatically. Any coupons already applied to the sub carry over.

Pre-flight: only use bill_now when the sub is ACTIVE (not paused or cancelled). If paused → resume first, then bill_now. If cancelled → reactivate first.

When to use change_next_date instead:
  - Customer wants the next order on a SPECIFIC future date ("ship on July 15", "wait until next month")
  - Customer wants to DELAY a renewal ("push back 2 weeks")
  - Date must be > today

LITMUS TEST: if the customer wants product TODAY/NOW, it's bill_now. If they want a different future date, it's change_next_date.`;

async function main() {
  const { data: existing } = await admin
    .from("sonnet_prompts")
    .select("id")
    .eq("workspace_id", WS)
    .eq("title", TITLE)
    .maybeSingle();
  if (existing) {
    console.log("- already exists, updating content");
    await admin.from("sonnet_prompts").update({ content: CONTENT, status: "approved" }).eq("id", existing.id);
    return;
  }
  const { error } = await admin
    .from("sonnet_prompts")
    .insert({
      workspace_id: WS,
      title: TITLE,
      content: CONTENT,
      category: "rule",
      status: "approved",
      derived_from_ticket_id: "20a4b3c2-4aa5-46b8-a749-64f56477ef26",
    });
  if (error) throw error;
  console.log("✓ added:", TITLE);
}
main().catch(e => { console.error(e); process.exit(1); });
