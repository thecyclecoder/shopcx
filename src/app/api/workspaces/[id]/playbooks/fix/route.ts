import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const SONNET = "claude-sonnet-4-20250514";

async function aiCall(system: string, user: string, maxTokens = 2000): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: SONNET, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) return `(AI error: ${res.status})`;
  const data = await res.json();
  return (data.content?.[0] as { text: string })?.text?.trim() || "";
}

interface Change {
  target: string; // e.g. "step:3:instructions", "policy:0:ai_talking_points", "exception:1:instructions"
  field_label: string; // Human-readable label
  old_value: string;
  new_value: string;
  reason: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { playbook_id, notes, simulation_result } = body as {
    playbook_id: string; notes: string; simulation_result: unknown;
  };

  if (!playbook_id || !notes) {
    return NextResponse.json({ error: "playbook_id and notes required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Load full playbook config
  const { data: playbook } = await admin.from("playbooks")
    .select("*").eq("id", playbook_id).single();
  if (!playbook) return NextResponse.json({ error: "Playbook not found" }, { status: 404 });

  const { data: steps } = await admin.from("playbook_steps")
    .select("*").eq("playbook_id", playbook_id).order("step_order");
  const { data: policies } = await admin.from("playbook_policies")
    .select("*").eq("playbook_id", playbook_id).order("sort_order");
  const { data: exceptions } = await admin.from("playbook_exceptions")
    .select("*").eq("playbook_id", playbook_id).order("tier");

  // Build current config summary for Sonnet
  const configSummary = buildConfigSummary(playbook, steps || [], policies || [], exceptions || []);

  const raw = await aiCall(
    `You are an expert at configuring customer support playbooks. The user ran a simulation of their playbook and found issues. They've written notes about what needs to change. Your job is to propose specific changes to the playbook configuration to fix these issues.

You can ONLY modify these text/instruction fields:
- Step instructions (what AI does at each step)
- Policy description (what AI tells the customer)
- Policy ai_talking_points (how to frame the policy)
- Exception instructions (how to present each offer)
- Playbook description
- Exception tier numbers (if escalation order is wrong)
- Stand firm max repetitions
- Exception limit

You CANNOT change:
- Step types or step order (structural changes)
- Condition JSON (the admin manages eligibility rules)
- Trigger intents or patterns
- Resolution types

Return a JSON array of changes. Each change object:
{
  "target": "step:<index>:instructions" | "policy:<index>:description" | "policy:<index>:ai_talking_points" | "exception:<index>:instructions" | "exception:<index>:tier" | "playbook:description" | "playbook:stand_firm_max" | "playbook:exception_limit",
  "field_label": "Human readable label like 'Step 3: Apply Policy — Instructions'",
  "old_value": "current value (abbreviated if very long, but include enough to identify)",
  "new_value": "your proposed new value",
  "reason": "Why this change fixes the issue (1 sentence)"
}

Be precise. Only change what the notes ask for. Don't rewrite things that are working fine. Keep the same tone and style as the existing text.

Return ONLY the JSON array, no markdown fences, no explanation outside the array.`,

    `## Current Playbook Configuration

${configSummary}

## Simulation Result

${JSON.stringify(simulation_result, null, 2).slice(0, 4000)}

## User's Notes (what needs to change)

${notes}

Generate the changes array:`,
    2000,
  );

  // Parse changes
  let changes: Change[] = [];
  try {
    const cleaned = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
    changes = JSON.parse(cleaned);
  } catch {
    return NextResponse.json({ error: "Failed to parse AI suggestions", raw }, { status: 500 });
  }

  // Resolve each change to actual DB IDs for applying later
  const resolvedChanges = changes.map(c => {
    const parts = c.target.split(":");
    const type = parts[0]; // step, policy, exception, playbook
    const idx = parseInt(parts[1]);
    const field = parts[2] || parts[1]; // field name

    let dbId: string | null = null;
    let table = "";

    if (type === "step" && steps?.[idx]) {
      dbId = steps[idx].id;
      table = "playbook_steps";
    } else if (type === "policy" && policies?.[idx]) {
      dbId = policies[idx].id;
      table = "playbook_policies";
    } else if (type === "exception" && exceptions?.[idx]) {
      dbId = exceptions[idx].id;
      table = "playbook_exceptions";
    } else if (type === "playbook") {
      dbId = playbook_id;
      table = "playbooks";
    }

    return { ...c, db_id: dbId, table, field };
  });

  return NextResponse.json({ changes: resolvedChanges });
}

// Apply changes
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { changes } = body as {
    changes: { db_id: string; table: string; field: string; new_value: string }[];
  };

  if (!changes?.length) return NextResponse.json({ error: "No changes" }, { status: 400 });

  for (const c of changes) {
    if (!c.db_id || !c.table || !c.field) continue;

    // Validate table names
    const allowedTables = ["playbooks", "playbook_steps", "playbook_policies", "playbook_exceptions"];
    if (!allowedTables.includes(c.table)) continue;

    // Validate field names per table
    const allowedFields: Record<string, string[]> = {
      playbooks: ["description", "stand_firm_max", "exception_limit"],
      playbook_steps: ["instructions"],
      playbook_policies: ["description", "ai_talking_points"],
      playbook_exceptions: ["instructions", "tier"],
    };
    if (!allowedFields[c.table]?.includes(c.field)) continue;

    // Type coerce numbers
    const value = ["stand_firm_max", "exception_limit", "tier"].includes(c.field)
      ? parseInt(c.new_value) || 0
      : c.new_value;

    const update: Record<string, unknown> = { [c.field]: value };
    if (c.table === "playbooks") update.updated_at = new Date().toISOString();

    await admin.from(c.table).update(update).eq("id", c.db_id);
  }

  return NextResponse.json({ ok: true, applied: changes.length });
}

function buildConfigSummary(
  playbook: Record<string, unknown>,
  steps: Record<string, unknown>[],
  policies: Record<string, unknown>[],
  exceptions: Record<string, unknown>[],
): string {
  const lines: string[] = [];
  lines.push(`Playbook: "${playbook.name}"`);
  lines.push(`Description: ${playbook.description || "(none)"}`);
  lines.push(`Exception limit: ${playbook.exception_limit} | Stand firm max: ${playbook.stand_firm_max}`);

  lines.push(`\n### Steps (${steps.length}):`);
  steps.forEach((s, i) => {
    lines.push(`[${i}] "${s.name}" (type: ${s.type})`);
    lines.push(`    Instructions: ${s.instructions || "(none)"}`);
    if (s.config && Object.keys(s.config as object).length) lines.push(`    Config: ${JSON.stringify(s.config)}`);
  });

  lines.push(`\n### Policies (${policies.length}):`);
  policies.forEach((p, i) => {
    lines.push(`[${i}] "${p.name}"`);
    lines.push(`    Description: ${p.description || "(none)"}`);
    lines.push(`    Conditions: ${JSON.stringify(p.conditions)}`);
    lines.push(`    AI talking points: ${p.ai_talking_points || "(none)"}`);
  });

  lines.push(`\n### Exceptions (${exceptions.length}):`);
  exceptions.forEach((e, i) => {
    lines.push(`[${i}] "${e.name}" — Tier ${e.tier} — ${e.resolution_type}${e.auto_grant ? " (AUTO-GRANT: " + e.auto_grant_trigger + ")" : ""}`);
    lines.push(`    Conditions: ${JSON.stringify(e.conditions)}`);
    lines.push(`    Instructions: ${e.instructions || "(none)"}`);
  });

  return lines.join("\n");
}
