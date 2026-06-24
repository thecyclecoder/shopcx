/**
 * Director directives (director-executable-plans-and-priority) — a director's ONE active directive: a plan the
 * CEO hands it via the coaching seat's `plan` intent (CEO-approved), which the standing pass runs FIRST, before
 * the routine lanes, and which can GATE the build queue until a named spec ships. The store + the gate check +
 * the lifecycle helpers live here; the box's standing pass and build lanes read them.
 *
 * North star: a directive re-prioritizes WHAT the director does, never loosens HOW (the leash/loop-guard/
 * escalation rails are unchanged). The CEO approves every directive and can clear it anytime.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap } from "@/lib/brain-roadmap";

type Admin = ReturnType<typeof createAdminClient>;

export interface DirectorDirective {
  id: string;
  workspace_id: string;
  director_function: string;
  summary: string;
  steps: string[];
  gate_builds_until: string | null;
  status: "active" | "done" | "cleared";
  created_at: string;
  completed_at: string | null;
}

/** The one active directive for a director, or null. */
export async function getActiveDirective(admin: Admin, workspaceId: string, directorFunction: string): Promise<DirectorDirective | null> {
  const { data } = await admin
    .from("director_directives")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("director_function", directorFunction)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { ...(data as DirectorDirective), steps: Array.isArray((data as DirectorDirective).steps) ? (data as DirectorDirective).steps : [] };
}

/**
 * Create + activate a directive (a new one supersedes the prior). Clears any existing active directive first
 * (so the partial-unique index never trips), then inserts the new one active. Best-effort.
 */
export async function createDirective(
  admin: Admin,
  args: { workspaceId: string; directorFunction: string; summary: string; steps?: string[]; gateBuildsUntil?: string | null; createdBy?: string | null },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!args.summary.trim()) return { ok: false, error: "a directive needs a summary" };
  await admin
    .from("director_directives")
    .update({ status: "cleared", completed_at: new Date().toISOString() })
    .eq("workspace_id", args.workspaceId)
    .eq("director_function", args.directorFunction)
    .eq("status", "active");
  const gate = args.gateBuildsUntil?.trim() ? args.gateBuildsUntil.trim().replace(/[^a-z0-9-]/gi, "") : null;
  const { data, error } = await admin
    .from("director_directives")
    .insert({
      workspace_id: args.workspaceId,
      director_function: args.directorFunction,
      summary: args.summary.slice(0, 2000),
      steps: (args.steps ?? []).map((s) => String(s).slice(0, 500)).slice(0, 30),
      gate_builds_until: gate,
      status: "active",
      created_by: args.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

/** Mark a directive done (its gate spec shipped, or the director finished it). */
export async function completeDirective(admin: Admin, id: string): Promise<void> {
  await admin.from("director_directives").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", id);
}

/**
 * The build gate. If the active directive names `gate_builds_until` and that spec is NOT yet shipped, the
 * build-enqueue lanes must pause for every spec EXCEPT the gate spec itself (so the gating fix lands first).
 * Returns the gating slug, or null when there's no gate (no directive, no gate set, or the gate spec shipped —
 * in which case the directive is auto-completed here, lifting the gate). Best-effort; never throws.
 */
export async function buildGate(admin: Admin, workspaceId: string, directorFunction: string): Promise<{ gatedUntil: string } | null> {
  try {
    const directive = await getActiveDirective(admin, workspaceId, directorFunction);
    if (!directive?.gate_builds_until) return null;
    const { specs } = await getRoadmap();
    const gateSpec = specs.find((s) => s.slug === directive.gate_builds_until);
    // Unknown slug or already shipped → lift the gate (+ auto-complete the directive when its gate spec shipped).
    if (!gateSpec || gateSpec.status === "shipped") {
      if (gateSpec?.status === "shipped") await completeDirective(admin, directive.id);
      return null;
    }
    return { gatedUntil: directive.gate_builds_until };
  } catch {
    return null; // a gate-check failure must never stall building — fail open
  }
}

/** Whether a given spec may be built right now given the gate (the gate spec itself is always allowed). */
export function gateAllowsBuild(gate: { gatedUntil: string } | null, specSlug: string): boolean {
  return !gate || gate.gatedUntil === specSlug;
}
