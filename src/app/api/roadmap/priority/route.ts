/**
 * POST /api/roadmap/priority — set/clear a spec's `**Priority:** critical` marker by
 * committing the line-anchored metadata line into docs/brain/specs/{slug}.md, straight to
 * main via the GitHub Contents API. The same line-anchored convention `parseSpec` reads to
 * derive `SpecCard.critical` (brain-roadmap.ts) — so the board pip flips after the commit.
 *
 * Owner-gated (mirrors /api/roadmap/status). Body: { slug, critical: boolean }.
 * See docs/brain/specs/director-executable-plans-and-priority-board-pip.md (Phase 1).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

/**
 * Add or remove the line-anchored `**Priority:** critical` marker. Mirrors the regex `parseSpec` uses
 * (`/^\s*\*\*Priority:\*\*\s*critical\b/i`). Setting inserts the marker as its own metadata line right
 * after the H1; clearing strips every matching line. Returns the input unchanged when already in the
 * desired state (so the caller can no-op the commit).
 */
function setPriorityCritical(md: string, critical: boolean): string {
  const lines = md.split("\n");
  const isMarker = (l: string) => /^\s*\*\*Priority:\*\*\s*critical\b/i.test(l);
  const has = lines.some(isMarker);
  if (critical) {
    if (has) return md;
    const i = lines.findIndex((l) => l.startsWith("# "));
    if (i < 0) return md;
    lines.splice(i + 1, 0, "", "**Priority:** critical");
    return lines.join("\n");
  }
  if (!has) return md;
  // Strip the marker line(s), plus a now-orphaned blank line left immediately above it.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMarker(lines[i])) {
      if (out.length && out[out.length - 1].trim() === "") out.pop();
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Add or remove the line-anchored `**Deferred:**` marker (mirrors setPriorityCritical for Deferred). */
function setDeferredMarker(md: string, deferred: boolean): string {
  const lines = md.split("\n");
  const isMarker = (l: string) => /^\s*\*\*Deferred:\*\*/i.test(l);
  const has = lines.some(isMarker);
  if (deferred) {
    if (has) return md;
    const i = lines.findIndex((l) => l.startsWith("# "));
    if (i < 0) return md;
    lines.splice(i + 1, 0, "", "**Deferred:** parked by the CEO — every auto-build lane skips it until promoted back to Planned.");
    return lines.join("\n");
  }
  if (!has) return md;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMarker(lines[i])) {
      if (out.length && out[out.length - 1].trim() === "") out.pop();
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** The unified 3-state priority (mutually exclusive): critical XOR deferred XOR planned (clears both). */
function applyPriorityState(md: string, state: "critical" | "deferred" | "planned"): string {
  if (state === "critical") return setDeferredMarker(setPriorityCritical(md, true), false);
  if (state === "deferred") return setPriorityCritical(setDeferredMarker(md, true), false);
  return setDeferredMarker(setPriorityCritical(md, false), false); // planned → clear both
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; critical?: unknown; state?: unknown };
  const { slug, critical } = body;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  // `state` is the unified Defer/Prioritize/Planned control; `critical:boolean` stays for the legacy toggle.
  const state = body.state === "critical" || body.state === "deferred" || body.state === "planned" ? body.state : null;
  if (!state && typeof critical !== "boolean") {
    return NextResponse.json({ error: "bad critical/state" }, { status: 400 });
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
  const updated = state ? applyPriorityState(current, state) : setPriorityCritical(current, critical as boolean);
  if (updated === current) return NextResponse.json({ ok: true, state: state ?? undefined, critical, unchanged: true });

  const put = await gh("PUT", `/repos/${REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`, {
    message: state ? `roadmap: ${slug} → ${state}` : `roadmap: ${critical ? "mark" : "clear"} ${slug} **Priority:** critical`,
    content: Buffer.from(updated, "utf8").toString("base64"),
    sha,
    branch: "main",
  });
  if (!put.ok) {
    return NextResponse.json({ error: "commit failed", status: put.status }, { status: 502 });
  }

  const commit = put.json.commit as { html_url?: string } | undefined;
  return NextResponse.json({ ok: true, state: state ?? undefined, critical, commit: commit?.html_url });
}
