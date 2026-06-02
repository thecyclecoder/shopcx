/**
 * Three-layer fix for ticket 22ee5944 (Elizabeth):
 *  1. Subscription policy didn't document the 90-day cap on change_next_date.
 *  2. Grader conflated pause_timed (30/60 day cap) with change_next_date.
 *  3. Override the bad 6/10 score to 10/10.
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
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "22ee5944-16db-4305-8764-c5f37f74acf4";
const ANALYSIS_ID = "7c396d79-e89b-40f7-86f1-71f1b80db37e";

const ADDITIONS = `- Pause durations: 30 or 60 days only via the pause_timed action. NEVER offer indefinite pause via pause_timed.
- LONGER REQUESTS (e.g., 90 days, 4 months, etc.) — use change_next_date instead. change_next_date supports up to 90 days max in a single push. For requests longer than 90 days, push to 90 and invite the customer to reach back out before then to extend further.
- IMPORTANT: pause_timed and change_next_date are TWO DIFFERENT mechanisms with DIFFERENT caps. pause_timed=30 or 60 days. change_next_date=up to 90 days. Using change_next_date for a 4-month-pause request (pushed to 90 days) is CORRECT.`;

const GRADER_RULE_TITLE = "pause_timed vs change_next_date — different caps, do not conflate";
const GRADER_RULE_CONTENT = `The customer-support AI has TWO separate mechanisms for pushing out a subscription, with DIFFERENT caps:

  • pause_timed(contract_id, pause_days) — 30 or 60 days ONLY. For shorter pause requests.
  • change_next_date(contract_id, date) — pushes next order date to a specific date, up to 90 days from today.

When a customer asks for a longer-than-60-day hold (e.g., "hold for 4 months", "push out 3 months"), the AI is CORRECT to use change_next_date pushed to today + 90 days, and to explain that 90 days is the longest single-shot delay. DO NOT flag this as a rule_violation or inaccuracy.

Only flag as a violation if:
  • The AI used pause_timed with a value other than 30 or 60.
  • The AI used change_next_date with a date more than 90 days out.
  • The AI offered an indefinite pause.

Calibration trigger: ticket 22ee5944 (Elizabeth, 2026-05-29) — customer asked for a 4-month hold; AI correctly applied change_next_date +90 days and explained the cap. Grader scored 6/10 citing the 60-day pause cap, which is the WRONG cap for the change_next_date mechanism.`;

async function main() {
  // 1. Update subscription policy
  const { data: pol } = await admin
    .from("policies")
    .select("id, internal_summary, version")
    .eq("workspace_id", WS)
    .eq("slug", "subscriptions")
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!pol) throw new Error("subscriptions policy not found");
  if (pol.internal_summary.includes("change_next_date supports up to 90 days")) {
    console.log("- policy already updated, skipping");
  } else {
    const oldLine = "- Pause durations: 30 or 60 days only. NEVER offer indefinite pause.";
    if (!pol.internal_summary.includes(oldLine)) throw new Error("could not find pause-durations line to replace");
    const updated = pol.internal_summary.replace(oldLine, ADDITIONS);
    await admin
      .from("policies")
      .update({ internal_summary: updated, version: pol.version + 1, updated_at: new Date().toISOString() })
      .eq("id", pol.id);
    console.log("✓ Subscription policy updated (v" + pol.version + " → v" + (pol.version + 1) + ")");
  }

  // 2. Add grader calibration rule
  const { data: existingRule } = await admin
    .from("grader_prompts")
    .select("id")
    .eq("workspace_id", WS)
    .eq("title", GRADER_RULE_TITLE)
    .maybeSingle();
  if (existingRule) {
    console.log("- grader rule already exists, skipping");
  } else {
    await admin
      .from("grader_prompts")
      .insert({
        workspace_id: WS,
        title: GRADER_RULE_TITLE,
        content: GRADER_RULE_CONTENT,
        status: "approved",
        derived_from_ticket_id: TICKET_ID,
      });
    console.log("✓ Grader rule added");
  }

  // 3. Override score
  await admin
    .from("ticket_analyses")
    .update({
      admin_score: 10,
      admin_score_reason: "Grader conflated pause_timed (30/60 day cap) with change_next_date (90 day cap). Customer asked for 4 months; AI correctly used change_next_date pushed to 90 days (the policy max for this mechanism) and explained that limit while inviting re-contact. Policy doc didn't previously document the change_next_date cap — fixed in both the subscriptions policy and a new grader calibration rule.",
      admin_corrected_at: new Date().toISOString(),
    })
    .eq("id", ANALYSIS_ID);
  console.log("✓ admin_score → 10");
}

main().catch((e) => { console.error(e); process.exit(1); });
