import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveApproverLive } from "@/lib/agents/approval-router";
import { recordDirectorActivity } from "@/lib/director-activity";
import { isWorkspaceOwner } from "@/lib/media-buyer/arm-auth";

// Media Buyer armed flip surface — Phase 1 of media-buyer-armed-flip-surface.
//
//   POST /api/growth/media-buyer/arm
//     body: { workspace_id, meta_ad_account_id?, direction: 'arm' | 'disarm', reason? }
//
// Arm path (owner-vetoable):
//   1. Load the latest media_buyer_arming_authorization row for (workspace, account?).
//      Missing / expired / allowed=false → 409 `authorization_stale`; no mode change.
//   2. resolveApproverLive('growth'). When Growth is NOT live+autonomous the approver
//      falls through to the CEO — do NOT mutate; drop a `needs_approval` agent_jobs
//      row so the CEO's approval-inbox surfaces the flip request. On approve the
//      supervising path re-runs the mutation.
//   3. Growth-approved / autonomous arm: UPDATE iteration_policies SET mode='armed'
//      WHERE workspace_id AND status='active' AND campaign_id IS NULL — the v1
//      workspace-scope rows (matches iteration-policy-authoring.ts). Compare-and-set
//      with .select('id') so a raced flip doesn't silently double-write.
//   4. Record one director_activity action_kind='media_buyer_armed' row with
//      { authorization_id, blended_cac_ltv_snapshot, actor }.
//
// Disarm path (never gated):
//   1. UPDATE iteration_policies SET mode='shadow' WHERE workspace_id AND status='active' AND campaign_id IS NULL.
//   2. Record one director_activity action_kind='media_buyer_disarmed' row with { reason, actor }.
//
// RBAC: workspace OWNER only. Both directions mutate iteration_policies.mode (arm→'armed',
// disarm→'shadow') — privileged Media Buyer mode changes — so membership is not enough; a
// non-owner member (e.g. an 'admin') must be rejected server-side, not merely hidden by the
// Phase 2 dashboard (client-side hiding is not authorization). Matches the owner-only gate on
// the other privileged growth/ads routes (e.g. api/ads/acquisition). Writes ride the
// service-role admin client past RLS, so this server check is the only real gate.

const GROWTH_FUNCTION = "growth";

/** The agent_jobs kind used when the flip needs supervisor approval (Growth not live+autonomous).
 *  Kept as a string constant so a future JobKind enum extension can pick it up without churn. */
const GROWTH_ARM_APPROVAL_KIND = "growth-director";

/** The PendingAction.type marker the approval-inbox / approve-lane reads to re-run the mutation. */
const APPLY_MEDIA_BUYER_ARM_ACTION_TYPE = "apply_media_buyer_arm";

interface ArmRequestBody {
  workspace_id?: unknown;
  meta_ad_account_id?: unknown;
  direction?: unknown;
  reason?: unknown;
}

interface AuthorizationRow {
  id: string;
  allowed: boolean;
  reasons: unknown;
  evaluated_at: string;
  expires_at: string;
}

async function assertWorkspaceOwner(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  // Owner-only: a missing membership OR a non-owner role (e.g. 'admin') is Forbidden. The
  // privileged mode flip must never be reachable by a non-owner — client-side button hiding
  // is not a substitute for this server-side role gate. See @/lib/media-buyer/arm-auth for
  // the pure predicate + its unit test.
  if (!isWorkspaceOwner(member)) {
    return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true };
}

async function loadLatestAuthorization(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  metaAdAccountId: string | null,
): Promise<AuthorizationRow | null> {
  const q = admin
    .from("media_buyer_arming_authorization")
    .select("id, allowed, reasons, evaluated_at, expires_at")
    .eq("workspace_id", workspaceId)
    .order("evaluated_at", { ascending: false })
    .limit(1);
  const { data } = metaAdAccountId
    ? await q.eq("meta_ad_account_id", metaAdAccountId).maybeSingle()
    : await q.is("meta_ad_account_id", null).maybeSingle();
  return (data ?? null) as AuthorizationRow | null;
}

/** Pull the CAC:LTV metric snapshot the arming-gate stored on the authorization row (see
 *  upsertAuthorization in src/lib/media-buyer/arming-gate.ts — reasons is { reasons, metrics }). */
function snapshotBlendedCacLtv(reasons: unknown): Record<string, unknown> | null {
  if (!reasons || typeof reasons !== "object") return null;
  const bag = reasons as Record<string, unknown>;
  const metrics = bag.metrics;
  if (!metrics || typeof metrics !== "object") return null;
  return metrics as Record<string, unknown>;
}

async function flipPolicyMode(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  mode: "armed" | "shadow",
): Promise<{ ok: boolean; updatedIds: string[]; error?: string }> {
  const { data, error } = await admin
    .from("iteration_policies")
    .update({ mode })
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("campaign_id", null)
    .select("id");
  if (error) return { ok: false, updatedIds: [], error: error.message };
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  return { ok: true, updatedIds: ids };
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: ArmRequestBody | null = null;
  try {
    body = (await req.json()) as ArmRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
  const metaAdAccountId = typeof body.meta_ad_account_id === "string" && body.meta_ad_account_id.trim()
    ? body.meta_ad_account_id.trim()
    : null;
  const direction = typeof body.direction === "string" ? body.direction.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  if (direction !== "arm" && direction !== "disarm") {
    return NextResponse.json({ error: "direction must be 'arm' or 'disarm'" }, { status: 400 });
  }

  const admin = createAdminClient();

  const gate = await assertWorkspaceOwner(admin, workspaceId, user.id);
  if (!gate.ok) return gate.res;

  if (direction === "disarm") {
    const disarm = await flipPolicyMode(admin, workspaceId, "shadow");
    if (!disarm.ok) {
      return NextResponse.json({ error: `iteration_policies update failed: ${disarm.error}` }, { status: 500 });
    }
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: GROWTH_FUNCTION,
      actionKind: "media_buyer_disarmed",
      specSlug: "media-buyer-armed-flip-surface",
      reason: reason || "manual",
      metadata: {
        reason: reason || "manual",
        meta_ad_account_id: metaAdAccountId,
        actor: user.id,
        updated_policy_ids: disarm.updatedIds,
        autonomous: false,
      },
    });
    return NextResponse.json({ ok: true, mode: "shadow", updated_policy_ids: disarm.updatedIds });
  }

  // ── Arm path ────────────────────────────────────────────────────────────────
  const authorization = await loadLatestAuthorization(admin, workspaceId, metaAdAccountId);
  const now = Date.now();
  const staleReason = !authorization
    ? "no authorization"
    : authorization.allowed !== true
      ? "authorization denied"
      : Date.parse(authorization.expires_at) < now
        ? "authorization expired"
        : null;
  if (staleReason) {
    return NextResponse.json(
      {
        error: "authorization_stale",
        detail: staleReason,
        authorization_id: authorization?.id ?? null,
        expires_at: authorization?.expires_at ?? null,
      },
      { status: 409 },
    );
  }
  // Non-null assertion is safe: staleReason is null only when authorization is non-null and allowed.
  const auth = authorization!;

  const routedTo = await resolveApproverLive(GROWTH_FUNCTION);
  const blendedSnapshot = snapshotBlendedCacLtv(auth.reasons);

  if (routedTo !== GROWTH_FUNCTION) {
    // Growth is not live+autonomous — do NOT mutate. Surface a needs_approval agent_jobs row
    // so the routed approver (typically the CEO) sees the flip request in the approval-inbox.
    // On approve, the worker path re-runs this route's arm branch against the approved row.
    const actionId = randomUUID();
    const summary = metaAdAccountId
      ? `Flip Media Buyer to ARMED for meta_ad_account ${metaAdAccountId}`
      : "Flip Media Buyer to ARMED (workspace-wide)";
    const pending = {
      id: actionId,
      type: APPLY_MEDIA_BUYER_ARM_ACTION_TYPE,
      status: "pending",
      summary,
      payload: {
        workspace_id: workspaceId,
        meta_ad_account_id: metaAdAccountId,
        authorization_id: auth.id,
        blended_cac_ltv_snapshot: blendedSnapshot,
        raised_by_actor: user.id,
      },
    };
    const { data: jobRow, error: jobErr } = await admin
      .from("agent_jobs")
      .insert({
        workspace_id: workspaceId,
        spec_slug: "media-buyer-armed-flip-surface",
        kind: GROWTH_ARM_APPROVAL_KIND,
        status: "needs_approval",
        created_by: null,
        instructions: JSON.stringify({
          workspace_id: workspaceId,
          meta_ad_account_id: metaAdAccountId,
          authorization_id: auth.id,
          direction: "arm",
        }),
        pending_actions: [pending],
      })
      .select("id")
      .maybeSingle();
    if (jobErr) {
      return NextResponse.json({ error: `approval job insert failed: ${jobErr.message}` }, { status: 500 });
    }
    return NextResponse.json(
      {
        ok: true,
        needs_approval: true,
        routed_to: routedTo,
        job_id: (jobRow as { id?: string } | null)?.id ?? null,
        authorization_id: auth.id,
      },
      { status: 202 },
    );
  }

  // Approved autonomously by live+autonomous Growth: mutate + audit.
  const flip = await flipPolicyMode(admin, workspaceId, "armed");
  if (!flip.ok) {
    return NextResponse.json({ error: `iteration_policies update failed: ${flip.error}` }, { status: 500 });
  }
  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: GROWTH_FUNCTION,
    actionKind: "media_buyer_armed",
    specSlug: "media-buyer-armed-flip-surface",
    reason: `Flipped Media Buyer to ARMED (authorization ${auth.id})`,
    metadata: {
      authorization_id: auth.id,
      meta_ad_account_id: metaAdAccountId,
      blended_cac_ltv_snapshot: blendedSnapshot,
      actor: user.id,
      updated_policy_ids: flip.updatedIds,
      routed_to: routedTo,
      autonomous: true,
    },
  });
  return NextResponse.json({
    ok: true,
    mode: "armed",
    authorization_id: auth.id,
    updated_policy_ids: flip.updatedIds,
  });
}
