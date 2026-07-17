/**
 * Storefront Optimizer policy — the Growth control surface (read + edit).
 *
 * GET  → the workspace's `storefront_optimizer_policy` (synthesized OFF defaults if
 *        no row yet) + the workspace's products so the scope picker can render.
 * PATCH → upsert the policy: the on/off switch, the enforced product_scope, the
 *        `auto_run_reversible` opt-in, and the editable guardrails. Owner/admin only.
 *
 * Only a human (or, later, the Growth director) edits this here — the optimizer
 * agent reads it read-only and never writes its own policy
 * (docs/brain/specs/storefront-optimizer-activation-gate.md).
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const POLICY_COLS =
  "id, workspace_id, active, product_scope, auto_run_reversible, max_concurrent_experiments, min_sample, holdout_pct, auto_rollback_ltv_tolerance, auto_rollback_windows, auto_rollback_refund_spike_delta, created_by, rationale, updated_at";

/** OFF-by-default shape returned when a workspace has no policy row yet. */
function defaultPolicy(workspaceId: string) {
  return {
    id: null,
    workspace_id: workspaceId,
    active: false,
    product_scope: [] as string[],
    auto_run_reversible: false,
    max_concurrent_experiments: 3,
    min_sample: 200,
    holdout_pct: 0.1,
    auto_rollback_ltv_tolerance: 0.15,
    auto_rollback_windows: 2,
    auto_rollback_refund_spike_delta: 0.1,
    created_by: "human" as const,
    rationale: null as string | null,
    updated_at: null as string | null,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: policy } = await admin
    .from("storefront_optimizer_policy")
    .select(POLICY_COLS)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  // Products for the scope picker — id + title + handle + whether published.
  const { data: products } = await admin
    .from("products")
    .select("id, title, handle, intelligence_status")
    .eq("workspace_id", workspaceId)
    .order("title", { ascending: true });

  return NextResponse.json({
    policy: policy ?? defaultPolicy(workspaceId),
    products: (products ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      published: p.intelligence_status === "published",
    })),
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = {};

  if ("active" in body) {
    if (typeof body.active !== "boolean") {
      return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
    }
    update.active = body.active;
  }

  if ("auto_run_reversible" in body) {
    if (typeof body.auto_run_reversible !== "boolean") {
      return NextResponse.json({ error: "auto_run_reversible must be a boolean" }, { status: 400 });
    }
    update.auto_run_reversible = body.auto_run_reversible;
  }

  if ("product_scope" in body) {
    if (
      !Array.isArray(body.product_scope) ||
      body.product_scope.some((p: unknown) => typeof p !== "string")
    ) {
      return NextResponse.json({ error: "product_scope must be an array of product ids" }, { status: 400 });
    }
    // Enforce that every scoped id is a real product in THIS workspace — scope is a
    // hard allowlist, never a free-text claim.
    const ids = Array.from(new Set(body.product_scope as string[]));
    if (ids.length) {
      const { data: valid } = await admin
        .from("products")
        .select("id")
        .eq("workspace_id", workspaceId)
        .in("id", ids);
      const validIds = new Set((valid ?? []).map((p) => p.id));
      const unknown = ids.filter((id) => !validIds.has(id));
      if (unknown.length) {
        return NextResponse.json(
          { error: `product_scope contains ids not in this workspace: ${unknown.join(", ")}` },
          { status: 400 },
        );
      }
    }
    update.product_scope = ids;
  }

  // Numeric guardrails — positive, finite; pct/tolerance fractions in [0,1).
  const intGuards: Array<[string, number]> = [
    ["max_concurrent_experiments", 1],
    ["min_sample", 1],
    ["auto_rollback_windows", 1],
  ];
  for (const [key, min] of intGuards) {
    if (key in body) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min) {
        return NextResponse.json({ error: `${key} must be an integer ≥ ${min}` }, { status: 400 });
      }
      update[key] = n;
    }
  }
  const fracGuards = [
    "holdout_pct",
    "auto_rollback_ltv_tolerance",
    "auto_rollback_refund_spike_delta",
  ];
  for (const key of fracGuards) {
    if (key in body) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0 || n >= 1) {
        return NextResponse.json({ error: `${key} must be a fraction in [0, 1)` }, { status: 400 });
      }
      update[key] = n;
    }
  }

  if ("rationale" in body) {
    update.rationale =
      typeof body.rationale === "string" && body.rationale.trim() ? body.rationale.trim() : null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // Upsert by workspace_id — create the row on first edit (table default is OFF).
  // created_by stays 'human' here; updated_by stamps who flipped it.
  const { data, error } = await admin
    .from("storefront_optimizer_policy")
    .upsert(
      { workspace_id: workspaceId, updated_by: user.id, updated_at: new Date().toISOString(), ...update },
      { onConflict: "workspace_id" },
    )
    .select(POLICY_COLS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, policy: data });
}
