/**
 * POST /api/roadmap/spec-drift — the one-tap owner resolution for a surfaced spec-drift case
 * (spec-drift-agent spec). The Control Tower's "Spec drift" section lists phases whose code is on
 * `main` but whose emoji is still ⏳/🚧 with no merged build on record — cases the reconciler won't
 * auto-flip. Two actions, owner-gated (mirrors /api/roadmap/status):
 *
 *   - flip:    rewrite the phase's leading emoji → ✅ on `main` (shared flipPhaseToShipped writer, so
 *              the manual flip and the auto-flip behave identically), resolve the drift row, and — if
 *              the spec is now fully shipped — enqueue a spec-test (spec-test-on-ship).
 *   - dismiss: leave the markdown; just resolve the drift row (the owner judged it not-drift).
 *
 * Only ever touches the leading phase emoji (+ a now-consistent H1) — never spec logic. Body:
 * { slug, phaseIndex, action }. See docs/brain/dashboard/control-tower.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveSpecStatus } from "@/lib/brain-roadmap";
import { enqueueSpecTestIfDue } from "@/lib/agent-jobs";
import { flipPhaseToShipped, resolveSpecDrift, phaseStatesFromRaw } from "@/lib/spec-drift";
import { markSpecCardStatus } from "@/lib/spec-card-state";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
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

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; phaseIndex?: unknown; action?: unknown };
  const { slug, phaseIndex, action } = body;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  if (typeof phaseIndex !== "number" || !Number.isInteger(phaseIndex) || phaseIndex < 0) {
    return NextResponse.json({ error: "bad phaseIndex" }, { status: 400 });
  }
  if (action !== "flip" && action !== "dismiss") {
    return NextResponse.json({ error: "bad action" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can resolve spec drift" }, { status: 403 });
  }

  // Dismiss: leave the markdown, just clear the surfaced row.
  if (action === "dismiss") {
    await resolveSpecDrift(workspaceId, slug, phaseIndex);
    return NextResponse.json({ ok: true, action: "dismiss" });
  }

  // Flip: rewrite the phase emoji → ✅ on main (shared writer).
  if (!ghToken()) return NextResponse.json({ error: "GitHub not configured" }, { status: 400 });
  const filePath = `docs/brain/specs/${slug}.md`;
  const get = await gh("GET", `/repos/${REPO}/contents/${filePath}?ref=main`);
  if (!get.ok) return NextResponse.json({ error: "spec not found" }, { status: 404 });

  const sha = get.json.sha as string;
  const current = Buffer.from(String(get.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
  const updated = flipPhaseToShipped(current, phaseIndex);
  if (updated === current) {
    // Already ✅ (or index out of range) — clear the stale row and report no-op.
    await resolveSpecDrift(workspaceId, slug, phaseIndex);
    return NextResponse.json({ ok: true, action: "flip", unchanged: true });
  }

  const put = await gh("PUT", `/repos/${REPO}/contents/${filePath}`, {
    message: `spec-drift: owner flip ${slug} P${phaseIndex + 1} → ✅`,
    content: Buffer.from(updated, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
  if (!put.ok) return NextResponse.json({ error: "commit failed", status: put.status }, { status: 502 });

  await resolveSpecDrift(workspaceId, slug, phaseIndex);

  // spec-card-db-companion: mirror the flipped status + per-phase snapshot to the board instantly (the
  // markdown bundle won't redeploy for minutes). Best-effort — never fail the flip on the mirror write.
  await markSpecCardStatus(workspaceId, slug, deriveSpecStatus(updated), phaseStatesFromRaw(updated));

  // spec-test-on-ship: if this flip leaves the spec fully shipped, enqueue a spec-test over the
  // just-committed content (local disk hasn't redeployed yet). Shared dedupe no-ops dupes.
  if (deriveSpecStatus(updated) === "shipped") {
    try {
      await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
    } catch {
      /* never fail the flip on enqueue trouble — the daily backlog cron mops it up */
    }
  }

  const commit = put.json.commit as { html_url?: string } | undefined;
  return NextResponse.json({ ok: true, action: "flip", status: deriveSpecStatus(updated), commit: commit?.html_url });
}
