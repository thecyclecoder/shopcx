/**
 * Slack → ShopCX identity bridge for the Slack Roadmap Console.
 *
 * Maps an inbound Slack user id to the ShopCX `workspace_members` row using the
 * saved team mapping (`workspace_members.slack_user_id`, populated by
 * `autoMapTeamMembers` / `lookupUserByEmail` at connect time). The resolved
 * `{ userId, role }` lets the Slack handlers filter the UX (owner-only buttons)
 * BEFORE calling an action — but it is NOT the security boundary: every mutating
 * `/api/roadmap/*` + `/api/branches/*` path (via `roadmap-actions.ts`) re-checks the
 * owner gate server-side regardless of what the Slack payload claims.
 *
 * See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md (Phase 2).
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface SlackActor {
  userId: string;
  role: string;
}

/**
 * Resolve a Slack user → the ShopCX member in this workspace, or null if unmapped.
 * Null means "not a known team member" — treat as non-owner (deny mutating actions).
 */
export async function resolveSlackActor(workspaceId: string, slackUserId: string): Promise<SlackActor | null> {
  if (!workspaceId || !slackUserId) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .eq("slack_user_id", slackUserId)
    .maybeSingle();
  if (!data?.user_id) return null;
  return { userId: data.user_id, role: data.role };
}

/** True when the resolved actor is the workspace owner (the only role allowed to mutate). */
export function isOwner(actor: SlackActor | null): boolean {
  return actor?.role === "owner";
}
