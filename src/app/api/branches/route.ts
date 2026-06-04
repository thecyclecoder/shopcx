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
import { createClient } from "@/lib/supabase/server";
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  if (!ghToken()) {
    return NextResponse.json({ configured: false, branches: [], total: 0 });
  }

  let pulls: GhPull[] = [];
  try {
    const all = (await gh(`/repos/${REPO}/pulls?state=open&per_page=100`)) as GhPull[];
    pulls = all.filter((p) => p.head?.ref?.startsWith("claude/"));
  } catch (err) {
    return NextResponse.json({ configured: true, error: String(err), branches: [], total: 0 }, { status: 502 });
  }

  // Match each PR to the todo that created it (execution_result.pr_url).
  const admin = createAdminClient();
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
      const todo = todoByUrl.get(p.html_url);
      return {
        number: p.number,
        title: p.title,
        url: p.html_url,
        branch: p.head.ref,
        created_at: p.created_at,
        ci,
        mergeable_state: p.mergeable_state || "unknown",
        changed_files: p.changed_files ?? null,
        todo_id: todo?.id || null,
        todo_summary: todo?.summary || null,
        action_type: todo?.action_type || null,
      };
    }),
  );

  return NextResponse.json({ configured: true, branches, total: branches.length });
}
