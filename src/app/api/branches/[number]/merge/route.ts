/**
 * POST /api/branches/[number]/merge — squash-merge an open `claude/*` PR.
 *
 * Owner-gated (merging to main is owner-level — mirrors the owner-only
 * approval of code_change / brain_doc_edit). Re-validates safety server-side
 * before merging: the PR must be open, a `claude/*` head, `mergeable === true`,
 * and `mergeable_state === "clean"` — so a stale client can't merge a
 * conflicting, behind, or blocked PR. On success, best-effort stamps the
 * originating agent_todo's execution_result.merged_at and deletes the branch.
 *
 * See docs/brain/dashboard/branches.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { mergeClaudePr } from "@/lib/roadmap-actions";

export async function POST(_request: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const prNumber = Number(number);

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Shared, owner-gated, server-revalidated merge (also called by the Slack Roadmap Console).
  const result = await mergeClaudePr(workspaceId, user.id, prNumber);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, merged: true, sha: result.sha });
}
