/**
 * GET /api/branches — open `claude/*` PRs the Routine has created.
 *
 * Queries the GitHub REST API for open PRs whose head branch starts with
 * `claude/`, enriches each with CI status (combined status of the head sha)
 * and the agent_todo that created it (matched via execution_result.pr_url).
 *
 * Requires a GitHub token in env (GITHUB_TOKEN or AGENT_TODO_GITHUB_TOKEN);
 * degrades to { configured: false } when absent so the page can show a hint.
 *
 * See docs/brain/dashboard/branches.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

interface GhPull {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  head: { ref: string; sha: string };
  mergeable_state?: string;
  changed_files?: number;
}

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(path: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function GET() {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  // Box worker health (worker-self-update Phase 3): running SHA + last poll, so "is the box behind?"
  // is answerable here instead of over SSH. Best-effort — the row is absent until the worker first ticks.
  const adminEarly = createAdminClient();
  const { data: hb } = await adminEarly
    .from("worker_heartbeats")
    .select("id, running_sha, status, active_builds, detail, last_poll_at")
    .eq("id", "box")
    .maybeSingle();
  const worker = hb
    ? {
        running_sha: hb.running_sha as string | null,
        status: hb.status as string,
        active_builds: hb.active_builds as number,
        detail: hb.detail as string | null,
        last_poll_at: hb.last_poll_at as string | null,
      }
    : null;

  if (!ghToken()) {
    return NextResponse.json({ configured: false, branches: [], total: 0, worker });
  }

  let pulls: GhPull[] = [];
  try {
    const all = (await gh(`/repos/${REPO}/pulls?state=open&per_page=100`)) as GhPull[];
    pulls = all.filter((p) => p.head?.ref?.startsWith("claude/"));
  } catch (err) {
    return NextResponse.json({ configured: true, error: String(err), branches: [], total: 0 }, { status: 502 });
  }

  // Match each PR to the todo that created it (execution_result.pr_url).
  const admin = adminEarly;
  const { data: todos } = await admin
    .from("agent_todos")
    .select("id, summary, action_type, execution_result")
    .eq("workspace_id", workspaceId)
    .in("status", ["executed", "approved"]);
  const todoByUrl = new Map<string, { id: string; summary: string; action_type: string }>();
  for (const t of todos || []) {
    const url = (t.execution_result as { pr_url?: string } | null)?.pr_url;
    if (url) todoByUrl.set(url, { id: t.id, summary: t.summary, action_type: t.action_type });
  }

  // CI status per head sha (best-effort, parallel).
  const branches = await Promise.all(
    pulls.map(async (p) => {
      let ci = "unknown";
      try {
        const st = (await gh(`/repos/${REPO}/commits/${p.head.sha}/status`)) as { state?: string };
        ci = st.state || "unknown"; // success | pending | failure
      } catch {
        ci = "unknown";
      }
      // The /pulls LIST endpoint doesn't populate mergeable / mergeable_state /
      // changed_files — only the single-PR GET does (and it nudges GitHub to
      // compute mergeability). Fetch it so the merge button can gate on safety.
      let mergeable: boolean | null = null;
      let mergeable_state = "unknown";
      let changed_files: number | null = null;
      try {
        const det = (await gh(`/repos/${REPO}/pulls/${p.number}`)) as {
          mergeable?: boolean | null;
          mergeable_state?: string;
          changed_files?: number;
        };
        mergeable = det.mergeable ?? null;
        mergeable_state = det.mergeable_state || "unknown";
        changed_files = det.changed_files ?? null;
      } catch {
        // leave defaults — button just won't show for this row
      }
      // Safe = GitHub says mergeable (no textual conflict) and the state is
      // either "clean" or "behind" (behind = base moved ahead, still a clean
      // squash; common since main advances). Block dirty/blocked/draft/unknown
      // and a red/pending CI. (No required checks → ci "unknown" is fine.)
      const safe_to_merge =
        mergeable === true &&
        (mergeable_state === "clean" || mergeable_state === "behind") &&
        ci !== "failure" &&
        ci !== "pending";

      const todo = todoByUrl.get(p.html_url);
      return {
        number: p.number,
        title: p.title,
        url: p.html_url,
        branch: p.head.ref,
        created_at: p.created_at,
        ci,
        mergeable_state,
        changed_files,
        safe_to_merge,
        todo_id: todo?.id || null,
        todo_summary: todo?.summary || null,
        action_type: todo?.action_type || null,
      };
    }),
  );

  return NextResponse.json({ configured: true, branches, total: branches.length, worker });
}
