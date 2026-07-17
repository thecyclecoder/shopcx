/**
 * /api/developer/agents/guide — a director's plain-English, self-updating "Guide".
 *
 * Owner-gated, read-only. `GET ?slug=<director_function>` composes the canonical runtime sources into a
 * non-technical-founder-readable summary of ONE director: who they are, what they're responsible for,
 * what they decide on their own vs. bring to the CEO (their leash), who their agents are (the live,
 * de-duped roster with liveness), and what they're working on (their goals + owned-spec count).
 *
 * EVERYTHING is runtime-derived — `getOrgChart()` (the brain functions + reconciled agent roster +
 * function_autonomy flags) and `getLeashGuide()` (each director's own LEASH_CATEGORIES). Nothing is
 * hardcoded per-director, so a newly-registered agent or a new functions/*.md director appears here
 * automatically. The Guide component (director-guide.tsx) polls this on an interval to stay current.
 *
 * See docs/brain/dashboard/agents.md § Guide tab.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgChart } from "@/lib/agents/org-chart";
import { getLeashGuide } from "@/lib/agents/director-leash-guide";

/** Plain-English rendering of the director's live/autonomous status (operational-rules § North star). */
function statusPlain(status: "offline" | "live" | "autonomous"): string {
  if (status === "autonomous") {
    return "Live & autonomous — acts on its own within its limits and escalates the big calls to you.";
  }
  if (status === "live") {
    return "Live (review mode) — proposes everything for your approval.";
  }
  return "Offline — all decisions route to you.";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "Missing ?slug" }, { status: 400 });

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
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view a director guide" }, { status: 403 });
  }

  const org = await getOrgChart();
  const director = org.directors.find((d) => d.slug === slug);
  if (!director) {
    return NextResponse.json({ error: "No such director" }, { status: 404 });
  }

  // Goals this director owns/contributes to — friendly title + status + % from the CEO's goal set
  // (so the names match exactly what the CEO sees, no second lookup).
  const goalBySlug = new Map(org.ceo.goals.map((g) => [g.slug, g]));
  const goals = director.goalSlugs
    .map((gs) => goalBySlug.get(gs))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .map((g) => ({ slug: g.slug, title: g.title, pct: g.pct, status: g.status }));

  // Owned-spec count across the director's mandates (the "what I'm working on" light metric).
  const specCount = director.mandates.reduce((n, m) => n + m.specCount, 0);

  // The team — the live, de-duped roster. The client resolves each persona (name/avatar/blurb) +
  // RESPONSIBILITIES from personas.ts (client-safe), so we only ship the kind + live status here.
  const team = director.workers.map((w) => ({
    kind: w.kind,
    label: w.label,
    status: w.status,
    statusReason: w.statusReason,
    flagged: w.flagged,
  }));

  return NextResponse.json({
    slug: director.slug,
    title: director.title,
    summary: director.summary,
    status: director.status,
    statusPlain: statusPlain(director.status),
    live: director.live,
    autonomous: director.autonomous,
    leash: getLeashGuide(director.slug),
    team,
    goals,
    specCount,
  });
}
