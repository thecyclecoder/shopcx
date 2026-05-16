/**
 * Insert Sonnet prompt rule: detect "wrong company / wrong product"
 * contacts and run the deactivate_ticket action so the AI sends one
 * clarification then never replies again.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const TITLE = "Wrong-company / wrong-product detection";
const BODY = `When a customer message describes a product, brand, ingredient, or company that is clearly NOT one of ours, this is a wrong-company contact. They reached out by mistake — they're not our customer.

DETECTION (any ONE of these is sufficient):
- They name a specific product (e.g. "your crispy beets", "the bacon flavor") and \`get_product_knowledge\` confirms no matching product in our catalog
- They mention a different company name in their message (e.g. "I bought from XYZ Foods")
- They describe an issue with an ingredient we don't use (e.g. "the bacon", "the gluten in your bread") that doesn't match anything in our product catalog
- They reference a product category we don't sell (cosmetics, electronics, etc.)

ACTION (do NOT escalate, do NOT ask clarifying questions, do NOT route to a journey):
\`\`\`json
{
  "action_type": "direct_action",
  "actions": [{
    "type": "deactivate_ticket",
    "reason": "wrong_product"   // or "wrong_company" if they named another brand
  }],
  "response_message": "<p>Hi! It looks like you may have reached out to the wrong company. We're Superfoods Company and we don't sell <product they mentioned>. The brand you're looking for should be printed on the package. Sorry for the mix-up!</p>"
}
\`\`\`

Why no escalation: there's nothing to resolve. They're not our customer. Sending one polite clarification and then going silent is the right behavior.

Why deactivate_ticket: any future reply on this ticket (often "oh sorry, you're right") shouldn't trigger the AI again. The flag short-circuits the handler.

If you are UNSURE whether the product is ours, prefer NOT to deactivate — use ai_response and ask "Which product specifically?" instead. Deactivation is one-way; only fire it when the wrong-company signal is unambiguous.`;

async function main() {
  // Idempotent — update if exists, insert otherwise
  const { data: existing } = await sb.from("sonnet_prompts")
    .select("id").eq("workspace_id", W).eq("title", TITLE).maybeSingle();

  if (existing) {
    const { error } = await sb.from("sonnet_prompts").update({
      content: BODY,
      category: "rule",
      sort_order: 0,
      enabled: true,
      updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    if (error) throw error;
    console.log(`Updated rule: ${existing.id}`);
  } else {
    const { data, error } = await sb.from("sonnet_prompts").insert({
      workspace_id: W,
      title: TITLE,
      content: BODY,
      category: "rule",
      sort_order: 0,
      enabled: true,
    }).select("id").single();
    if (error) throw error;
    console.log(`Inserted rule: ${data.id}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
