/**
 * /api/director/coach/directors — the Message Center's director-tab list.
 *
 * MessageCenterChat is a client component; it can't import server-only getOrgChart or
 * director-leash-guide. This owner-gated GET returns the shape it needs to build its tab bar:
 * one entry per director that is BOTH `live` in the org chart AND has a registered
 * `<name>-director.ts` leash module (so the M1 coach backend can accept it). Sorted by the
 * org-chart's own director order (Ada, Max, June — persona display order).
 *
 *   GET → { directors: [{ slug, name, personaAccent, leashSummary }] }
 *
 * Eve is deliberately NOT in the list — she is the CEO's assistant, not a leash-bound director,
 * and the Message Center renders her tab hardcoded + visually distinct.
 *
 * See docs/brain/libraries/director-coach-threads.md (backend), docs/brain/functions/platform.md
 * (owner), and .box/spec-message-center-director-tabs.md Phase 1.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgChart } from "@/lib/agents/org-chart";
import { getLeashGuide, getRegisteredDirectorSlugs } from "@/lib/agents/director-leash-guide";
import { getPersona } from "@/lib/agents/personas";

interface DirectorTab {
  slug: string;
  name: string;
  personaAccent: string;
  leashSummary: string;
}

async function gate(): Promise<{ ok: false; res: NextResponse } | { ok: true; workspaceId: string; userId: string }> {
  const { user } = await getAuthedUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { ok: false, res: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return { ok: false, res: NextResponse.json({ error: "Owner only" }, { status: 403 }) };
  }
  return { ok: true, workspaceId, userId: user.id };
}

export async function GET() {
  const g = await gate();
  if (!g.ok) return g.res;

  const chart = await getOrgChart();
  const registered = getRegisteredDirectorSlugs();

  const directors: DirectorTab[] = [];
  for (const d of chart.directors) {
    if (!d.live) continue;
    if (!registered.has(d.slug)) continue;
    const persona = getPersona(d.slug);
    const guide = getLeashGuide(d.slug);
    const leashSummary = guide.autonomous.map((l) => l.title).join(" · ");
    directors.push({ slug: d.slug, name: persona.name, personaAccent: persona.accent, leashSummary });
  }

  return NextResponse.json({ directors });
}
