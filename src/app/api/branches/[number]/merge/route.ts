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
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {} };
}

export async function POST(_request: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const prNumber = Number(number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: "bad PR number" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  if (!ghToken()) return NextResponse.json({ error: "GitHub not configured" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can merge to main" }, { status: 403 });
  }

  // Re-validate safety server-side — never trust the client's view.
  const pr = await gh("GET", `/repos/${REPO}/pulls/${prNumber}`);
  if (!pr.ok) return NextResponse.json({ error: `PR fetch failed (${pr.status})` }, { status: 502 });
  const head = (pr.json.head as { ref?: string } | undefined)?.ref;
  if (pr.json.state !== "open") return NextResponse.json({ error: "PR is not open" }, { status: 409 });
  if (!head?.startsWith("claude/")) {
    return NextResponse.json({ error: "Only claude/* PRs can be merged here" }, { status: 403 });
  }
  const state = pr.json.mergeable_state as string | undefined;
  if (pr.json.mergeable !== true || (state !== "clean" && state !== "behind")) {
    return NextResponse.json(
      { error: `Not safe to merge (mergeable_state: ${state || "unknown"})` },
      { status: 409 },
    );
  }

  // Squash-merge.
  const merge = await gh("PUT", `/repos/${REPO}/pulls/${prNumber}/merge`, {
    merge_method: "squash",
    commit_title: `${pr.json.title as string} (#${prNumber})`,
  });
  if (!merge.ok) {
    return NextResponse.json(
      { error: `Merge failed: ${(merge.json.message as string) || merge.status}` },
      { status: 502 },
    );
  }

  // Best-effort: stamp the originating todo as merged + delete the branch.
  const prUrl = pr.json.html_url as string | undefined;
  if (prUrl) {
    const { data: todos } = await admin
      .from("agent_todos")
      .select("id, execution_result")
      .eq("workspace_id", workspaceId)
      .eq("status", "executed");
    const match = (todos || []).find(
      (t) => (t.execution_result as { pr_url?: string } | null)?.pr_url === prUrl,
    );
    if (match) {
      await admin
        .from("agent_todos")
        .update({
          execution_result: { ...(match.execution_result as object || {}), merged_at: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        })
        .eq("id", match.id);
    }
  }
  if (head) {
    await gh("DELETE", `/repos/${REPO}/git/refs/heads/${head}`).catch(() => {});
  }

  return NextResponse.json({ ok: true, merged: true, sha: merge.json.sha });
}
