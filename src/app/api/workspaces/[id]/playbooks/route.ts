import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List playbooks with policies, exceptions, and steps
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: playbooks } = await admin.from("playbooks")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("priority", { ascending: false });

  const result = [];
  for (const pb of playbooks || []) {
    const { data: policies } = await admin.from("playbook_policies")
      .select("*").eq("playbook_id", pb.id).order("sort_order");
    const { data: exceptions } = await admin.from("playbook_exceptions")
      .select("*").eq("playbook_id", pb.id).order("tier");
    const { data: steps } = await admin.from("playbook_steps")
      .select("*").eq("playbook_id", pb.id).order("step_order");

    result.push({ ...pb, policies: policies || [], exceptions: exceptions || [], steps: steps || [] });
  }

  return NextResponse.json({ playbooks: result });
}

// POST: Create playbook
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();

  const { data, error } = await admin.from("playbooks").insert({
    workspace_id: workspaceId,
    name: body.name,
    description: body.description || null,
    trigger_intents: body.trigger_intents || [],
    trigger_patterns: body.trigger_patterns || [],
    priority: body.priority || 0,
    is_active: body.is_active ?? true,
    exception_limit: body.exception_limit || 1,
    stand_firm_max: body.stand_firm_max || 3,
    stand_firm_before_exceptions: body.stand_firm_before_exceptions ?? 2,
    stand_firm_between_tiers: body.stand_firm_between_tiers ?? 2,
    exception_disqualifiers: body.exception_disqualifiers || [],
    disqualifier_behavior: body.disqualifier_behavior || "silent",
  }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

// PATCH: Update playbook (supports bulk save of steps, policies, exceptions)
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
  const { playbook_id, steps, policies, exceptions, ...updates } = body;

  if (!playbook_id) return NextResponse.json({ error: "playbook_id required" }, { status: 400 });

  // Update playbook-level fields
  const playbookFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of ["name", "description", "trigger_intents", "trigger_patterns", "priority", "is_active", "exception_limit", "stand_firm_max", "stand_firm_before_exceptions", "stand_firm_between_tiers", "exception_disqualifiers", "disqualifier_behavior"]) {
    if (key in updates) playbookFields[key] = updates[key];
  }
  await admin.from("playbooks").update(playbookFields).eq("id", playbook_id).eq("workspace_id", workspaceId);

  // Reconcile steps: delete removed, upsert remaining
  if (Array.isArray(steps)) {
    const incomingIds = steps.filter((s: { id?: string }) => s.id && !s.id.startsWith("new_")).map((s: { id: string }) => s.id);
    // Delete steps not in incoming list
    const { data: existing } = await admin.from("playbook_steps").select("id").eq("playbook_id", playbook_id);
    const toDelete = (existing || []).filter(e => !incomingIds.includes(e.id)).map(e => e.id);
    if (toDelete.length) await admin.from("playbook_steps").delete().in("id", toDelete);
    // Upsert steps
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const row = {
        workspace_id: workspaceId,
        playbook_id,
        step_order: i,
        type: s.type,
        name: s.name,
        instructions: s.instructions || null,
        data_access: s.data_access || [],
        resolved_condition: s.resolved_condition || null,
        config: s.config || {},
        skippable: s.skippable ?? true,
      };
      if (s.id && !s.id.startsWith("new_")) {
        await admin.from("playbook_steps").update(row).eq("id", s.id);
      } else {
        await admin.from("playbook_steps").insert(row);
      }
    }
  }

  // Reconcile policies: delete removed, upsert remaining
  if (Array.isArray(policies)) {
    const incomingIds = policies.filter((p: { id?: string }) => p.id && !p.id.startsWith("new_")).map((p: { id: string }) => p.id);
    const { data: existing } = await admin.from("playbook_policies").select("id").eq("playbook_id", playbook_id);
    const toDelete = (existing || []).filter(e => !incomingIds.includes(e.id)).map(e => e.id);
    // Delete exceptions tied to deleted policies first
    if (toDelete.length) {
      await admin.from("playbook_exceptions").delete().in("policy_id", toDelete);
      await admin.from("playbook_policies").delete().in("id", toDelete);
    }
    // Upsert policies — return IDs for exception mapping
    const policyIdMap: Record<string, string> = {};
    for (let i = 0; i < policies.length; i++) {
      const p = policies[i];
      const row = {
        workspace_id: workspaceId,
        playbook_id,
        name: p.name,
        description: p.description || null,
        conditions: p.conditions || {},
        ai_talking_points: p.ai_talking_points || null,
        sort_order: i,
      };
      if (p.id && !p.id.startsWith("new_")) {
        await admin.from("playbook_policies").update(row).eq("id", p.id);
        policyIdMap[p.id] = p.id;
      } else {
        const { data } = await admin.from("playbook_policies").insert(row).select("id").single();
        if (data) policyIdMap[p.id || `idx_${i}`] = data.id;
      }
    }

    // Reconcile exceptions if provided
    if (Array.isArray(exceptions)) {
      const incomingExIds = exceptions.filter((e: { id?: string }) => e.id && !e.id.startsWith("new_")).map((e: { id: string }) => e.id);
      const { data: existingEx } = await admin.from("playbook_exceptions").select("id").eq("playbook_id", playbook_id);
      const toDeleteEx = (existingEx || []).filter(e => !incomingExIds.includes(e.id)).map(e => e.id);
      if (toDeleteEx.length) await admin.from("playbook_exceptions").delete().in("id", toDeleteEx);
      for (let i = 0; i < exceptions.length; i++) {
        const e = exceptions[i];
        const resolvedPolicyId = policyIdMap[e.policy_id] || e.policy_id;
        const row = {
          workspace_id: workspaceId,
          playbook_id,
          policy_id: resolvedPolicyId,
          tier: e.tier || 1,
          name: e.name,
          conditions: e.conditions || {},
          resolution_type: e.resolution_type,
          instructions: e.instructions || null,
          auto_grant: e.auto_grant || false,
          auto_grant_trigger: e.auto_grant_trigger || null,
          sort_order: i,
        };
        if (e.id && !e.id.startsWith("new_")) {
          await admin.from("playbook_exceptions").update(row).eq("id", e.id);
        } else {
          await admin.from("playbook_exceptions").insert(row);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}

// DELETE: Delete playbook
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const playbookId = url.searchParams.get("id");
  if (!playbookId) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("playbooks").delete().eq("id", playbookId).eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}
