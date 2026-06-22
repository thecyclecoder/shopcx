/**
 * Storefront Optimizer policy — the Growth control surface
 * (docs/brain/specs/storefront-optimizer-activation-gate.md).
 *
 * GET   → the workspace's storefront_optimizer_policy (a default OFF shape if none yet).
 * PATCH → flip `active`, edit `product_scope`, or tune guardrails. The engine never
 *         writes its own policy — only the owner/Growth director does (here).
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_OPTIMIZER_GUARDRAILS } from "@/lib/storefront/optimizer-policy";

async function authorize(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };

  return { user, admin };
}

/** The shape returned to the dashboard — a real row, or a default OFF policy. */
function defaultPolicy(workspaceId: string) {
  return {
    workspace_id: workspaceId,
    active: false,
    product_scope: [] as string[],
    ...DEFAULT_OPTIMIZER_GUARDRAILS,
    version: 1,
    created_by: "human" as const,
    rationale: null as string | null,
    activated_at: null as string | null,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth.error) return auth.error;

  const { data, error } = await auth.admin
    .from("storefront_optimizer_policy")
    .select("*")
    .eq("workspace_id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data ?? defaultPolicy(id));
}

const GUARDRAIL_KEYS = [
  "max_concurrent_experiments",
  "min_sample_sessions",
  "holdout_pct",
  "ltv_regression_tolerance",
  "regression_windows_to_rollback",
  "refund_spike_delta",
] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth.error) return auth.error;

  const body = (await req.json()) as Record<string, unknown>;

  // Current row (if any) → merge so a partial PATCH never clobbers untouched fields.
  const { data: existing } = await auth.admin
    .from("storefront_optimizer_policy")
    .select("*")
    .eq("workspace_id", id)
    .maybeSingle();
  const current = existing ?? defaultPolicy(id);

  const update: Record<string, unknown> = {
    workspace_id: id,
    version: existing ? Number(current.version ?? 1) + 1 : 1,
    created_by: "human",
    updated_at: new Date().toISOString(),
  };

  // active — flipping true stamps the activation audit.
  if (typeof body.active === "boolean") {
    update.active = body.active;
    if (body.active && !current.active) {
      update.activated_by = auth.user.id;
      update.activated_at = new Date().toISOString();
    }
  }

  // product_scope — the enforced allowlist (array of product_id uuids).
  if (Array.isArray(body.product_scope)) {
    update.product_scope = (body.product_scope as unknown[]).filter((x): x is string => typeof x === "string");
  }

  if (typeof body.rationale === "string") update.rationale = body.rationale;

  for (const k of GUARDRAIL_KEYS) {
    if (typeof body[k] === "number" && Number.isFinite(body[k])) update[k] = body[k];
  }

  const { data, error } = await auth.admin
    .from("storefront_optimizer_policy")
    .upsert(update, { onConflict: "workspace_id" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}
