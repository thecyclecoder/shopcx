/**
 * POST /api/roadmap/priority — set / clear a spec's `**Priority:** critical` marker by rewriting a
 * metadata line under the H1 in docs/brain/specs/{slug}.md, committed straight to main via the GitHub
 * Contents API (director-executable-plans-and-priority Phase 1). The brain markdown stays the source of
 * truth (no DB override) — the board re-derives `critical` from the marker on the next read.
 *
 * A `critical` spec is queued ahead of normal Planned specs by the director's build picker (Phase 2) and
 * can be the target of a directive's build-gate. This is the BOARD lever; the CHAT lever is a directive's
 * criticalSpecs[] (both write the same marker via setCriticalMarker).
 *
 * Owner-gated (mirrors /api/roadmap/status). Body: { slug, critical }.
 * See docs/brain/dashboard/roadmap.md · docs/brain/libraries/brain-roadmap.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { setCriticalMarker } from "@/lib/brain-roadmap";

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
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; critical?: unknown };
  const { slug, critical } = body;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  if (typeof critical !== "boolean") {
    return NextResponse.json({ error: "bad critical" }, { status: 400 });
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
    return NextResponse.json({ error: "Only the workspace owner can change roadmap priority" }, { status: 403 });
  }

  if (!ghToken()) return NextResponse.json({ error: "GitHub not configured" }, { status: 400 });

  const filePath = `docs/brain/specs/${slug}.md`;
  const get = await gh("GET", `/repos/${REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=main`);
  if (!get.ok) return NextResponse.json({ error: "spec not found" }, { status: 404 });

  const sha = get.json.sha as string;
  const current = Buffer.from(String(get.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
  const updated = setCriticalMarker(current, critical);
  if (updated === current) return NextResponse.json({ ok: true, critical, unchanged: true });

  const put = await gh("PUT", `/repos/${REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`, {
    message: `roadmap: ${critical ? "mark" : "clear"} ${slug} → priority ${critical ? "critical" : "normal"}`,
    content: Buffer.from(updated, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
  if (!put.ok) {
    return NextResponse.json({ error: "commit failed", status: put.status }, { status: 502 });
  }

  const commit = put.json.commit as { html_url?: string } | undefined;
  return NextResponse.json({ ok: true, critical, commit: commit?.html_url });
}
