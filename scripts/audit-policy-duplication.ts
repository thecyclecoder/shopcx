/**
 * Audit: what content across the system duplicates the new policies table?
 *
 * Surfaces:
 *   1. playbooks.description
 *   2. playbook_steps.instructions
 *   3. playbook_exceptions.instructions
 *   4. playbook_policies.description / ai_talking_points
 *   5. macros.body_html / body_text
 *   6. sonnet_prompts (already audited, mostly folded — re-check residuals)
 *   7. workflows (instructions, if any)
 *   8. journey_definitions (descriptions, if any)
 *
 * For each, flag rows whose text matches policy keywords. Print with row id +
 * title + a snippet so we can decide: KEEP (procedural), FOLD (delete/disable),
 * UPDATE (replace text with a "see policy" pointer).
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

const POLICY_KEYWORDS = /\b(30[\s-]?day|money[\s-]?back|refund|return|exchange|replacement|prepaid label|MBG|subscription policy|cancellation|subscriber discount|grandfathered|MSRP floor|stand firm|tier 1|tier 2|crisis swap|out of stock|shipping protection|pause for 30|pause for 60|next renewal|48 hours)\b/i;

function snippet(text: string, max = 200): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

async function main() {
  const { data: ws } = await admin.from("workspaces").select("id").eq("name", "Superfoods Company").single();
  const wsId = ws!.id;

  // 1. Playbook descriptions
  console.log("=== PLAYBOOK DESCRIPTIONS ===");
  const { data: pbs } = await admin.from("playbooks").select("id, name, description").eq("workspace_id", wsId).eq("is_active", true);
  for (const p of pbs || []) {
    if (p.description && POLICY_KEYWORDS.test(p.description)) {
      console.log(`  [${p.name}] ${snippet(p.description)}`);
    }
  }

  // 2. Playbook steps
  console.log("\n=== PLAYBOOK STEP INSTRUCTIONS (with policy keywords) ===");
  const { data: steps } = await admin.from("playbook_steps").select("playbook_id, step_order, type, name, instructions").eq("workspace_id", wsId);
  const pbName = new Map((pbs || []).map(p => [p.id, p.name]));
  for (const s of steps || []) {
    if (s.instructions && POLICY_KEYWORDS.test(s.instructions)) {
      const name = pbName.get(s.playbook_id) || "?";
      console.log(`  [${name} → ${s.type}/${s.name}]`);
      console.log(`    ${snippet(s.instructions, 300)}`);
    }
  }

  // 3. Playbook exceptions
  console.log("\n=== PLAYBOOK EXCEPTION INSTRUCTIONS (with policy keywords) ===");
  const { data: excs } = await admin.from("playbook_exceptions").select("playbook_id, tier, name, instructions").eq("workspace_id", wsId);
  for (const e of excs || []) {
    if (e.instructions && POLICY_KEYWORDS.test(e.instructions)) {
      const name = pbName.get(e.playbook_id) || "?";
      console.log(`  [${name} → tier ${e.tier}: ${e.name}]`);
      console.log(`    ${snippet(e.instructions, 300)}`);
    }
  }

  // 4. Playbook policies (separate table)
  console.log("\n=== PLAYBOOK_POLICIES (table) ===");
  const { data: pbPolicies } = await admin.from("playbook_policies").select("playbook_id, name, description, ai_talking_points").eq("workspace_id", wsId);
  for (const p of pbPolicies || []) {
    console.log(`  [${pbName.get(p.playbook_id) || "?"} → ${p.name}]`);
    if (p.description) console.log(`    desc: ${snippet(p.description, 200)}`);
    if (p.ai_talking_points) console.log(`    talking: ${snippet(p.ai_talking_points, 200)}`);
  }

  // 5. Macros
  console.log("\n=== MACROS (with policy keywords) ===");
  const { data: macros } = await admin.from("macros").select("id, name, category, body_text, body_html").eq("workspace_id", wsId);
  let macroCount = 0;
  for (const m of macros || []) {
    const text = (m.body_text || "") + " " + (m.body_html || "");
    if (POLICY_KEYWORDS.test(text)) {
      macroCount++;
      console.log(`  [${m.category}] ${m.name}`);
      console.log(`    ${snippet(text, 250)}`);
    }
  }
  console.log(`  (${macroCount} macros flagged)`);

  // 6. Remaining sonnet_prompts (only enabled, non-folded ones)
  console.log("\n=== REMAINING SONNET_PROMPTS (enabled, with policy keywords) ===");
  const { data: prompts } = await admin.from("sonnet_prompts").select("id, title, category, content").eq("workspace_id", wsId).eq("enabled", true);
  let promptCount = 0;
  for (const p of prompts || []) {
    if (p.title.startsWith("[FOLDED]")) continue;
    if (p.content && POLICY_KEYWORDS.test(p.content)) {
      promptCount++;
      console.log(`  [${p.category}] ${p.title}`);
      console.log(`    ${snippet(p.content, 200)}`);
    }
  }
  console.log(`  (${promptCount} enabled prompts flagged)`);

  // 7. Workflows
  console.log("\n=== WORKFLOWS ===");
  const cols = await admin.from("workflows").select("*").eq("workspace_id", wsId).limit(1);
  if (cols.data?.[0]) {
    const has_instructions = Object.keys(cols.data[0]).includes("instructions");
    if (has_instructions) {
      const { data: wfs } = await admin.from("workflows").select("name, instructions").eq("workspace_id", wsId);
      for (const w of wfs || []) {
        const inst = (w as { instructions?: string }).instructions || "";
        if (inst && POLICY_KEYWORDS.test(inst)) {
          console.log(`  [${w.name}] ${snippet(inst, 200)}`);
        }
      }
    } else {
      console.log("  (workflows table has no instructions column)");
    }
  }

  // 8. Journey definitions
  console.log("\n=== JOURNEY DEFINITIONS (description) ===");
  const { data: journeys } = await admin.from("journey_definitions").select("name, description").eq("workspace_id", wsId).eq("is_active", true);
  for (const j of journeys || []) {
    if (j.description && POLICY_KEYWORDS.test(j.description)) {
      console.log(`  [${j.name}] ${snippet(j.description, 200)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
