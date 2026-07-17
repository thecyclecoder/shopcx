/**
 * GET /api/dashboard/sidebar-counts — db-load-sidebar-counts.
 *
 * ONE authenticated request that returns every sidebar badge count in a single JSON blob, so the
 * always-mounted dashboard sidebar (src/app/dashboard/sidebar.tsx) can drop its 13-17 per-badge
 * fetches to ONE poll per 60s tick. Each per-badge fetch previously paid its own auth.getUser() +
 * PostgREST set_config preamble; this endpoint shares a single auth check across every count and
 * runs the underlying admin count queries in Promise.allSettled so a partial DB error never blanks
 * the whole sidebar. Owner-only fields stay server-scoped: the `owner` bundle is only populated
 * when workspace_members.role === 'owner'; the `improve_waiting` count is only populated for
 * owner/admin/cs_manager (mirrors /api/tickets/improve-queue). Branches count uses the same
 * GitHub token as /api/branches and degrades to null if the token is absent.
 *
 * Response shape is stable: each field's value is derived from the SAME underlying query the
 * original per-badge endpoint fires, so counts match what the badge would have shown pre-consolidation.
 *
 * See docs/brain/dashboard/sidebar-counts.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WorkspaceRole } from "@/lib/types/workspace";
import { canApprove, ALL_ACTION_TYPES, type AgentTodoActionType } from "@/lib/agent-todos/constants";
import { countEscalatedApprovals } from "@/lib/agents/approvals-feed";
import { countOpenSecurityReviews } from "@/lib/security-agent";
import { getHumanTestQueue } from "@/lib/spec-test-runs";
import { listBlueprints, listContentGaps } from "@/lib/lander-blueprints";
import type { ChatMsg, TurnStatus } from "@/lib/ticket-improve-chats";

const IMPROVE_ALLOWED_ROLES = ["owner", "admin", "cs_manager"];
const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

export interface SidebarTicketView {
  id: string;
  name: string;
  filters: Record<string, string>;
  parent_id: string | null;
  count: number | null;
}

export interface SidebarOwnerCounts {
  human_test_waiting: number;
  regressions: number;
  approvals_escalated: number;
  security_surfaced: number;
  lander_uploads_pending: number;
}

export interface SidebarCountsResponse {
  role: WorkspaceRole;
  ticket_views: SidebarTicketView[];
  escalation: { open: number; pending: number; closed: number };
  fraud: { count: number; maxSeverity: "low" | "medium" | "high" } | null;
  pending_reviews: number;
  todos_approvable: number;
  rejected_me: number;
  improve_waiting: number | null;
  branches: number | null;
  owner: SidebarOwnerCounts | null;
}

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function countClaudeBranches(): Promise<number | null> {
  const token = ghToken();
  if (!token) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/pulls?state=open&per_page=100`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const pulls = (await res.json()) as Array<{ head?: { ref?: string } }>;
    return pulls.filter((p) => p.head?.ref?.startsWith("claude/")).length;
  } catch {
    return null;
  }
}

// Improve queue: mirror /api/tickets/improve-queue's `counts.waiting` (unread waiting sessions
// = answered | needs_approval | error that the operator hasn't marked read since the last box turn).
type ImproveQueueState = "answered" | "needs_approval" | "error" | "thinking" | "idle";
const IMPROVE_WAITING_STATES: ImproveQueueState[] = ["answered", "needs_approval", "error"];

function lastRole(messages: unknown): "user" | "assistant" | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as ChatMsg | undefined;
  return last?.role === "assistant" || last?.role === "user" ? last.role : null;
}
function deriveImproveState(turnStatus: TurnStatus, messages: unknown): ImproveQueueState {
  if (turnStatus === "awaiting_approval") return "needs_approval";
  if (turnStatus === "error") return "error";
  if (turnStatus === "thinking") return "thinking";
  return lastRole(messages) === "assistant" ? "answered" : "idle";
}

export async function GET() {
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
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const role = member.role as WorkspaceRole;
  const isOwner = role === "owner";
  const isAdminOrOwner = role === "owner" || role === "admin";
  const canImprove = IMPROVE_ALLOWED_ROLES.includes(role);
  const nowIso = new Date().toISOString();

  const safe = <T>(p: PromiseLike<T>, def: T): Promise<T> =>
    Promise.resolve(p).catch(() => def);

  // === Ticket views + per-view counts (one grouped read of view rows + parallel per-view counts,
  // capped at 100 per view to match the pre-consolidation endpoint's semantics). ===
  const ticketViewsPromise: Promise<SidebarTicketView[]> = safe(
    (async () => {
      const { data: views } = await admin
        .from("ticket_views")
        .select("id, name, filters, parent_id, sort_order")
        .eq("workspace_id", workspaceId)
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true });
      if (!views || views.length === 0) return [];
      return Promise.all(
        views.map(async (view) => {
          const filters = ((view.filters || {}) as Record<string, string>) ?? {};
          const base: SidebarTicketView = {
            id: view.id as string,
            name: view.name as string,
            filters,
            parent_id: (view.parent_id as string | null) ?? null,
            count: null,
          };
          if (Object.keys(filters).length === 0) return base;
          let q = admin
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId);
          if (filters.status) q = q.eq("status", filters.status);
          if (filters.channel) q = q.eq("channel", filters.channel);
          if (filters.assigned_to) q = q.eq("assigned_to", filters.assigned_to);
          if (filters.tag) q = q.contains("tags", [filters.tag]);
          if (filters.search) q = q.ilike("subject", `%${filters.search}%`);
          q = q.or(`snoozed_until.is.null,snoozed_until.lte.${nowIso}`).limit(100);
          const { count } = await q;
          return { ...base, count: count ?? 0 };
        }),
      );
    })(),
    [],
  );

  // === Escalation buckets (mine): 3 parallel head counts. Preserves the /api/tickets
  //     `escalation_mine=true` predicate: `escalated_to IS NOT NULL AND (escalated_to = me OR
  //     assigned_to = me)` + snoozed excluded. ===
  const escBase = () =>
    admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .not("escalated_to", "is", null)
      .or(`escalated_to.eq.${user.id},assigned_to.eq.${user.id}`)
      .or(`snoozed_until.is.null,snoozed_until.lte.${nowIso}`);
  const escalationPromise = Promise.all([
    safe(
      escBase()
        .eq("status", "open")
        .then((r) => r.count ?? 0),
      0,
    ),
    safe(
      escBase()
        .eq("status", "pending")
        .then((r) => r.count ?? 0),
      0,
    ),
    safe(
      escBase()
        .eq("status", "closed")
        .then((r) => r.count ?? 0),
      0,
    ),
  ]).then(([open, pending, closed]) => ({ open, pending, closed }));

  // === Fraud (owner/admin only): count + severity of the newest open case (matches sidebar's
  //     current `limit=1` semantics). ===
  const fraudPromise: Promise<SidebarCountsResponse["fraud"]> = isAdminOrOwner
    ? safe(
        (async () => {
          const [{ count }, { data: newest }] = await Promise.all([
            admin
              .from("fraud_cases")
              .select("id", { count: "exact", head: true })
              .eq("workspace_id", workspaceId)
              .eq("status", "open"),
            admin
              .from("fraud_cases")
              .select("severity")
              .eq("workspace_id", workspaceId)
              .eq("status", "open")
              .order("created_at", { ascending: false })
              .limit(1),
          ]);
          const first = (newest || [])[0] as { severity?: string } | undefined;
          const sev = first?.severity as "low" | "medium" | "high" | undefined;
          const maxSeverity: "low" | "medium" | "high" =
            sev === "high" ? "high" : sev === "medium" ? "medium" : "low";
          return { count: count ?? 0, maxSeverity };
        })(),
        null,
      )
    : Promise.resolve(null);

  // === Pending reviews: mirrors reviews route's `stats.pending`. ===
  const pendingReviewsPromise = safe(
    admin
      .from("product_reviews")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .then((r) => r.count ?? 0),
    0,
  );

  // === Approvable todos: mirrors /api/todos `approvable_count` (pending todos this role can
  //     approve, from ALL_ACTION_TYPES × canApprove). ===
  const approvableTypes = ALL_ACTION_TYPES.filter((t) => canApprove(role, t));
  const todosPromise = safe(
    admin
      .from("agent_todos")
      .select("action_type")
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .then((r) =>
        (r.data || []).filter((t) =>
          approvableTypes.includes((t as { action_type: string }).action_type as AgentTodoActionType),
        ).length,
      ),
    0,
  );

  // === Rejected → me: mirrors /api/escalated `chips.rejected_me` — a ticket is "rejected → me"
  //     when it's escalated + still open, its escalated_to = me, and it has any rejected agent_todo.
  //     The endpoint pulls at most 500 escalated tickets + all their todos; do the same shape here. ===
  const rejectedMePromise = safe(
    (async () => {
      const { data: tickets } = await admin
        .from("tickets")
        .select("id, escalated_to")
        .eq("workspace_id", workspaceId)
        .not("escalated_at", "is", null)
        .not("status", "in", "(closed,resolved,archived)")
        .eq("escalated_to", user.id)
        .order("escalated_at", { ascending: false })
        .limit(500);
      const rows = (tickets || []) as Array<{ id: string; escalated_to: string | null }>;
      if (rows.length === 0) return 0;
      const ids = rows.map((t) => t.id);
      const { data: todos } = await admin
        .from("agent_todos")
        .select("source_ticket_id, status")
        .in("source_ticket_id", ids)
        .eq("status", "rejected");
      const rejectedTicketIds = new Set(
        (todos || []).map((td) => (td as { source_ticket_id: string }).source_ticket_id).filter(Boolean),
      );
      return rows.filter((t) => rejectedTicketIds.has(t.id)).length;
    })(),
    0,
  );

  // === Improve waiting (owner/admin/cs_manager only): mirrors improve-queue's `counts.waiting`
  //     (unread + waiting state). ===
  const improveWaitingPromise: Promise<number | null> = canImprove
    ? safe(
        (async () => {
          const { data } = await admin
            .from("ticket_improve_chats")
            .select("turn_status, messages, updated_at, seen_at")
            .eq("workspace_id", workspaceId)
            .eq("status", "active")
            .order("updated_at", { ascending: false })
            .limit(200);
          let waiting = 0;
          for (const row of (data || []) as Array<{
            turn_status: TurnStatus | null;
            messages: unknown;
            updated_at: string;
            seen_at: string | null;
          }>) {
            const state = deriveImproveState(row.turn_status ?? "idle", row.messages);
            if (!IMPROVE_WAITING_STATES.includes(state)) continue;
            const unread =
              row.seen_at === null || new Date(row.updated_at).getTime() > new Date(row.seen_at).getTime();
            if (unread) waiting += 1;
          }
          return waiting;
        })(),
        0,
      )
    : Promise.resolve(null);

  // === Branches (owner/admin): GitHub open PRs starting with `claude/`. Degrades to null on
  //     token-absent / GH failure. ===
  const branchesPromise: Promise<number | null> = isAdminOrOwner
    ? safe(countClaudeBranches(), null)
    : Promise.resolve(null);

  // === Owner-only bundle: human-test queue + escalated approvals + surfaced security + open
  //     lander_content_gaps on awaiting_upload blueprints. ===
  const ownerPromise: Promise<SidebarOwnerCounts | null> = isOwner
    ? Promise.all([
        safe(getHumanTestQueue(workspaceId).then((q) => q.counts), { waiting: 0, resolved: 0, regressions: 0 }),
        safe(countEscalatedApprovals(admin, workspaceId), 0),
        safe(countOpenSecurityReviews(admin, workspaceId), 0),
        safe(
          (async () => {
            const blueprints = await listBlueprints(workspaceId, { status: "awaiting_upload" });
            if (blueprints.length === 0) return 0;
            const gapArrays = await Promise.all(
              blueprints.map((b) => listContentGaps(workspaceId, { blueprint_id: b.id, status: "open" })),
            );
            return gapArrays.reduce((sum, arr) => sum + arr.length, 0);
          })(),
          0,
        ),
      ]).then(([spec, approvals, security, lander]) => ({
        human_test_waiting: spec.waiting,
        regressions: spec.regressions,
        approvals_escalated: approvals,
        security_surfaced: security,
        lander_uploads_pending: lander,
      }))
    : Promise.resolve(null);

  const [
    ticket_views,
    escalation,
    fraud,
    pending_reviews,
    todos_approvable,
    rejected_me,
    improve_waiting,
    branches,
    owner,
  ] = await Promise.all([
    ticketViewsPromise,
    escalationPromise,
    fraudPromise,
    pendingReviewsPromise,
    todosPromise,
    rejectedMePromise,
    improveWaitingPromise,
    branchesPromise,
    ownerPromise,
  ]);

  const response: SidebarCountsResponse = {
    role,
    ticket_views,
    escalation,
    fraud,
    pending_reviews,
    todos_approvable,
    rejected_me,
    improve_waiting,
    branches,
    owner,
  };
  return NextResponse.json(response);
}
