/**
 * POST /api/developer/agents/cs-director/digests/[id]/reply — the founder's per-storyline reply
 * action on the /dashboard/agents/cs-director/digests surface.
 *
 * Phase 2 of [[docs/brain/specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]].
 * Body: `{ storyline_index: number, action: 'widen_leash' | 'tighten_leash' | 'add_policy' | 'add_rule' }`.
 * Applies the mutation via [[../../../../../../../lib/cs-director-digest-reply]] then stamps the
 * digest's `ceo_replied_at` + `ceo_reply_action` via a COMPARE-AND-SET so a stale click or replay
 * can't overwrite an already-actioned digest.
 *
 * Owner-gated (mirrors POST /api/developer/agents/autonomy — leash + policy + rule writes are all
 * founder-only in the org-chart model).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CsStoryline } from "@/lib/cs-director-digest";
import {
  addPolicyFromStoryline,
  addRuleFromStoryline,
  stampDigestReply,
  tightenCsLeash,
  widenCsLeash,
  type CsDigestReplyActionType,
  type CsDigestReplyRecord,
  type CsDigestReplyResult,
} from "@/lib/cs-director-digest-reply";

const VALID_ACTIONS: readonly CsDigestReplyActionType[] = ["widen_leash", "tighten_leash", "add_policy", "add_rule"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: digestId } = await ctx.params;
  if (!digestId) return NextResponse.json({ error: "digestId required" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can reply to CS Director digests" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { storyline_index?: unknown; action?: unknown }
    | null;
  const storylineIndex = typeof body?.storyline_index === "number" && Number.isInteger(body.storyline_index) ? body.storyline_index : -1;
  const actionRaw = typeof body?.action === "string" ? (body.action as string) : "";
  if (storylineIndex < 0) return NextResponse.json({ error: "storyline_index required" }, { status: 400 });
  if (!VALID_ACTIONS.includes(actionRaw as CsDigestReplyActionType)) {
    return NextResponse.json({ error: `action must be one of: ${VALID_ACTIONS.join(", ")}` }, { status: 400 });
  }
  const action = actionRaw as CsDigestReplyActionType;

  // Load the digest — workspace-scoped read; the storylines array indexes into via storyline_index.
  const { data: digest, error: readErr } = await admin
    .from("cs_director_digests")
    .select("id, storylines, ceo_replied_at")
    .eq("id", digestId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: "Failed to read digest" }, { status: 500 });
  if (!digest) return NextResponse.json({ error: "digest not found" }, { status: 404 });

  // The compare-and-set stamp below is the AUTHORITATIVE guard against "already replied" — but
  // short-circuit early here so the mutation doesn't fire pointlessly against `policies` /
  // `sonnet_prompts` for an already-actioned digest.
  if (digest.ceo_replied_at) {
    return NextResponse.json({ error: "digest already actioned" }, { status: 409 });
  }
  const storylines = Array.isArray(digest.storylines) ? (digest.storylines as CsStoryline[]) : [];
  if (storylineIndex >= storylines.length) {
    return NextResponse.json({ error: "storyline_index out of range" }, { status: 400 });
  }
  const storyline = storylines[storylineIndex];

  const actor = member.display_name ?? user.email ?? "owner";

  // Dispatch the mutation for the chosen action.
  let mutation: CsDigestReplyResult;
  if (action === "widen_leash") {
    mutation = await widenCsLeash(admin, actor);
  } else if (action === "tighten_leash") {
    mutation = await tightenCsLeash(admin, actor);
  } else if (action === "add_policy") {
    mutation = await addPolicyFromStoryline(admin, { workspaceId, storyline, digestId, actor });
  } else {
    mutation = await addRuleFromStoryline(admin, { workspaceId, storyline, actor });
  }

  if (!mutation.ok) {
    return NextResponse.json({ error: "action failed", detail: mutation.reason }, { status: 500 });
  }

  const record: CsDigestReplyRecord = {
    storyline_index: storylineIndex,
    action_type: action,
    actor,
    ...(mutation.autonomy ? { autonomy: mutation.autonomy } : {}),
    ...(mutation.policy_id ? { policy_id: mutation.policy_id } : {}),
    ...(mutation.sonnet_prompt_id ? { sonnet_prompt_id: mutation.sonnet_prompt_id } : {}),
    applied_at: new Date().toISOString(),
  };

  const stamp = await stampDigestReply(admin, { workspaceId, digestId, record });
  if (!stamp.ok) {
    // The mutation landed but the stamp missed (either raced or the compare-and-set said the digest
    // was already stamped). We do NOT roll back the mutation — a policy/rule seed is safe to keep,
    // and a leash walk is idempotent per-position. Surface the stamp reason so the client can show
    // "action applied, but the digest was already actioned — refresh".
    return NextResponse.json(
      { ok: true, mutation, stamp_reason: stamp.reason },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: true, applied: record });
}
