/**
 * GET /api/developer/agents/inbox?role={ceo|slug} — a role's three-tab inbox
 * (agents-hub-role-inboxes spec, Phase 3).
 *
 * Owner-gated, read-only. The CEO inbox is wired LIVE first: it queries the reserved
 * `agent_*` notification types out of [[dashboard_notifications]] and buckets them
 * into Messages / Approval Requests / Daily Summaries. Director inboxes return empty
 * with `routesToCeo: true` — M1 reality is no director is automated, so everything
 * routes up to the CEO (the approval-routing engine in M2 flips this). The shell only
 * reads; it never routes or writes. See docs/brain/dashboard/agents.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_INBOX_TYPES, tabForType, type InboxItem, type InboxPayload } from "@/lib/agents/inbox";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
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
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view the Agents hub" }, { status: 403 });
  }

  const role = new URL(req.url).searchParams.get("role") || "ceo";

  // M1: only the CEO inbox is live (no director is automated → everything routes up).
  if (role !== "ceo") {
    const payload: InboxPayload = { role, routesToCeo: true, items: [] };
    return NextResponse.json(payload);
  }

  const { data: rows } = await admin
    .from("dashboard_notifications")
    .select("id, type, title, body, link, read, created_at")
    .eq("workspace_id", workspaceId)
    .in("type", AGENT_INBOX_TYPES)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(200);

  const items: InboxItem[] = (rows ?? []).flatMap((r) => {
    const tab = tabForType(r.type as string);
    if (!tab) return [];
    return [
      {
        id: r.id as string,
        tab,
        type: r.type as string,
        title: (r.title as string) ?? "",
        body: (r.body as string | null) ?? null,
        link: (r.link as string | null) ?? null,
        read: Boolean(r.read),
        createdAt: r.created_at as string,
      },
    ];
  });

  const payload: InboxPayload = { role: "ceo", routesToCeo: false, items };
  return NextResponse.json(payload);
}
