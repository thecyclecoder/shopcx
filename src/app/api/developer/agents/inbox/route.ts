/**
 * GET /api/developer/agents/inbox?role={ceo|slug} — a role's three-tab inbox
 * (agents-hub-role-inboxes spec, Phase 3 · approval-routing-engine M2).
 *
 * Owner-gated, read-only. Queries the reserved `agent_*` notification types out of
 * [[dashboard_notifications]] and buckets them into Messages / Approval Requests /
 * Daily Summaries.
 *
 * Approval routing (M2): an `agent_approval_request` carries the function it routed to in
 * `metadata.routed_to_function` (the emitter walks the org chart up to the first live+autonomous
 * ancestor, else the CEO — see [[approval-router]]). A role's inbox shows only the approvals routed
 * TO it; a director that is NOT an auto-approver captures nothing → `routesToCeo: true` (its items
 * route up to the CEO). The CEO inbox additionally carries any legacy/unrouted approval + the M3/M4
 * Messages & Daily-Summaries (not routed). The shell only reads; the emitter does the routing.
 * See docs/brain/dashboard/agents.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_INBOX_TYPES, APPROVAL_REQUEST_TYPE, tabForType, type InboxItem, type InboxPayload } from "@/lib/agents/inbox";
import { loadAutonomyMap, isAutoApprover, CEO } from "@/lib/agents/approval-router";
import { inlineApproveActions, type ApprovalJobRow } from "@/lib/agents/approval-inbox";
import { laneForBounceBack } from "@/lib/agents/director-bounce-back";


export async function GET(req: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view the Agents hub" }, { status: 403 });
  }

  const role = new URL(req.url).searchParams.get("role") || CEO;
  const isCeo = role === CEO;

  // Route by the live flags: the CEO is the root (never routes up); a director captures approvals
  // only when it is an auto-approver (live && autonomous) — otherwise everything it would own routes
  // up to the CEO, so its inbox is empty (M2 keystone, same fail-safe as resolveApprover).
  const autonomy = await loadAutonomyMap();
  const routesToCeo = !isCeo && !isAutoApprover(role, autonomy);
  if (routesToCeo) {
    const payload: InboxPayload = { role, routesToCeo: true, items: [] };
    return NextResponse.json(payload);
  }

  const { data: rows } = await admin
    .from("dashboard_notifications")
    .select("id, type, title, body, link, read, created_at, metadata")
    .eq("workspace_id", workspaceId)
    .in("type", AGENT_INBOX_TYPES)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(200);

  // Approval Requests are decided INLINE in the inbox (approval-routing-engine Phase 4 — multi-action /
  // multi-branch). Read each gated job's LIVE pending_actions (not the notification's emit-time snapshot)
  // so a half-decided multi-branch plan shows only the still-pending branches. One batched fetch.
  const approvalJobIds = Array.from(
    new Set(
      (rows ?? [])
        .filter((r) => r.type === APPROVAL_REQUEST_TYPE)
        .map((r) => (r.metadata as Record<string, unknown> | null)?.["agent_job_id"])
        .filter((v): v is string => typeof v === "string"),
    ),
  );
  const jobActions = new Map<string, ReturnType<typeof inlineApproveActions>>();
  if (approvalJobIds.length) {
    const { data: jobRows } = await admin
      .from("agent_jobs")
      .select("id, pending_actions")
      .in("id", approvalJobIds);
    for (const j of jobRows ?? []) {
      jobActions.set(j.id as string, inlineApproveActions({ pending_actions: j.pending_actions } as ApprovalJobRow));
    }
  }

  const items: InboxItem[] = (rows ?? []).flatMap((r) => {
    const tab = tabForType(r.type as string);
    if (!tab) return [];
    const type = r.type as string;
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};

    if (type === APPROVAL_REQUEST_TYPE) {
      // Show only the approvals routed to THIS role (legacy/unrouted ⇒ the CEO).
      const routedTo = typeof meta["routed_to_function"] === "string" ? (meta["routed_to_function"] as string) : CEO;
      if (routedTo !== role) return [];
      const approveActionId = typeof meta["approve_action_id"] === "string" ? (meta["approve_action_id"] as string) : null;
      const jobId = typeof meta["agent_job_id"] === "string" ? (meta["agent_job_id"] as string) : undefined;
      const actions = (jobId && jobActions.get(jobId)) || undefined;
      // bounce-escalation-back-to-director — surface the metadata the CEO inbox needs to render
      // "Send back to {Director}" next to Dismiss on a director-escalation card.
      const escalatedBy = typeof meta["escalated_by_director"] === "string" ? (meta["escalated_by_director"] as string) : null;
      const bounceLane = laneForBounceBack(meta);
      const bouncedBackDepth = typeof meta["bounced_back_depth"] === "number" ? (meta["bounced_back_depth"] as number) : 0;
      return [
        {
          id: r.id as string,
          tab,
          type,
          title: (r.title as string) ?? "",
          body: (r.body as string | null) ?? null,
          link: (r.link as string | null) ?? null,
          read: Boolean(r.read),
          createdAt: r.created_at as string,
          jobId,
          approveActionId,
          actions: actions ?? undefined,
          deepLink: typeof meta["deep_link"] === "string" ? (meta["deep_link"] as string) : (r.link as string | null) ?? null,
          routedTo,
          escalatedBy,
          bounceLane,
          bouncedBackDepth,
        },
      ];
    }

    // Messages / Daily Summaries (M3/M4) aren't routed — they surface in the CEO inbox only.
    if (!isCeo) return [];
    return [
      {
        id: r.id as string,
        tab,
        type,
        title: (r.title as string) ?? "",
        body: (r.body as string | null) ?? null,
        link: (r.link as string | null) ?? null,
        read: Boolean(r.read),
        createdAt: r.created_at as string,
      },
    ];
  });

  const payload: InboxPayload = { role, routesToCeo: false, items };
  return NextResponse.json(payload);
}
