/**
 * POST /api/roadmap/status — set a spec's overall status by rewriting the ⏳/🚧/✅
 * emoji on its H1 in docs/brain/specs/{slug}.md, committed straight to main via the
 * GitHub Contents API. The brain markdown stays the source of truth (no DB overrides).
 *
 * Owner-gated (mirrors the branches merge route). Body: { slug, status }.
 * See docs/brain/dashboard/roadmap.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveSpecStatus } from "@/lib/brain-roadmap";
import { enqueueSpecTestIfDue } from "@/lib/agent-jobs";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
const EMOJI = { planned: "⏳", in_progress: "🚧", shipped: "✅", rejected: "❌" } as const;
type Status = keyof typeof EMOJI;

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

/** Rewrite the H1 line's status emoji (strip any existing, append the target). */
function setH1Status(md: string, status: Status): string {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.startsWith("# "));
  if (i < 0) return md;
  const cleaned = lines[i].replace(/[⏳🚧✅]/g, "").replace(/\s+$/, "");
  lines[i] = `${cleaned} ${EMOJI[status]}`;
  return lines.join("\n");
}

/** Rewrite the Nth "## Phase …" heading's status emoji (0-based, matches the board parser order). */
function setPhaseStatus(md: string, idx: number, status: Status): string {
  const lines = md.split("\n");
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Phase\b/.test(lines[i])) {
      seen++;
      if (seen === idx) {
        const cleaned = lines[i].replace(/[⏳🚧✅]/g, "").replace(/\s+$/, "");
        lines[i] = `${cleaned} ${EMOJI[status]}`;
        break;
      }
    }
  }
  return lines.join("\n");
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; status?: unknown; phaseIndex?: unknown };
  const { slug, status } = body;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  if (status !== "planned" && status !== "in_progress" && status !== "shipped" && status !== "rejected") {
    return NextResponse.json({ error: "bad status" }, { status: 400 });
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
    return NextResponse.json({ error: "Only the workspace owner can change roadmap status" }, { status: 403 });
  }

  if (!ghToken()) return NextResponse.json({ error: "GitHub not configured" }, { status: 400 });

  const filePath = `docs/brain/specs/${slug}.md`;
  const get = await gh("GET", `/repos/${REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=main`);
  if (!get.ok) return NextResponse.json({ error: "spec not found" }, { status: 404 });

  const sha = get.json.sha as string;
  const current = Buffer.from(String(get.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
  const idx = typeof body.phaseIndex === "number" ? body.phaseIndex : null;
  const updated = idx !== null ? setPhaseStatus(current, idx, status) : setH1Status(current, status);
  if (updated === current) return NextResponse.json({ ok: true, status, unchanged: true });

  const put = await gh("PUT", `/repos/${REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`, {
    message: `roadmap: set ${slug}${idx !== null ? ` phase ${idx}` : ""} → ${status}`,
    content: Buffer.from(updated, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
  if (!put.ok) {
    return NextResponse.json({ error: "commit failed", status: put.status }, { status: 502 });
  }
  // spec-test-on-ship: if this flip leaves the spec's derived status `shipped`, enqueue a spec-test now
  // (over the just-committed content — local disk hasn't redeployed yet). Shared dedupe no-ops dupes.
  if (deriveSpecStatus(updated) === "shipped") {
    try {
      await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
    } catch {
      /* never fail the status commit on enqueue trouble — the daily backlog cron mops it up */
    }
  }

  const commit = put.json.commit as { html_url?: string } | undefined;
  return NextResponse.json({ ok: true, status, commit: commit?.html_url });
}
