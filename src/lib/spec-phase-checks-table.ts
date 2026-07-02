/**
 * spec-phase-checks-table — SDK for `public.spec_phase_checks` (pm-structured-intent-and-refs
 * Phase 3), the structured replacement for the free-text `spec_phases.verification` blob.
 *
 * One row per verification check on a phase — `{position, description, kind}`. `kind='auto'` means
 * the spec-test agent runs it directly (non-destructive); `kind='human'` parks it needs_human. The
 * upsert rule mirrors `spec_phases`: replace-by-position preserves stable ids on re-author.
 *
 * The author chokepoint ([[author-spec]] `assertEveryPhaseHasChecks`) gates ≥1 check per phase —
 * same rail as the existing verification-text gate. Both surfaces are written during the migration
 * window so legacy readers keep functioning.
 *
 * Service-role only via `createAdminClient()`.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type SpecPhaseCheckKind = "auto" | "human";

export interface SpecPhaseCheckRow {
  id: string;
  phase_id: string;
  position: number;
  description: string;
  kind: SpecPhaseCheckKind;
  created_at: string;
  updated_at: string;
}

export interface SpecPhaseCheckInput {
  position: number;
  description: string;
  kind: SpecPhaseCheckKind;
}

/**
 * REPLACE-by-position rule (mirrors `upsertSpec` on phases): matching positions UPDATE in place
 * (stable id preserved), new positions INSERT, vanished positions DELETE. Idempotent.
 *
 * Passing `checks: []` clears every check for the phase. The author chokepoint is responsible for
 * gating "≥1 check per phase" — this writer accepts what it's told.
 */
export async function upsertPhaseChecks(phaseId: string, checks: SpecPhaseCheckInput[]): Promise<void> {
  const admin = createAdminClient();
  const { data: existing, error: exErr } = await admin
    .from("spec_phase_checks")
    .select("id, position")
    .eq("phase_id", phaseId);
  if (exErr) throw exErr;
  const byPosition = new Map<number, string>();
  for (const p of (existing ?? []) as { id: string; position: number }[]) byPosition.set(p.position, p.id);

  const inputPositions = new Set(checks.map((c) => c.position));
  const toDelete: number[] = [];
  for (const pos of byPosition.keys()) if (!inputPositions.has(pos)) toDelete.push(pos);
  if (toDelete.length) {
    const { error: dErr } = await admin
      .from("spec_phase_checks")
      .delete()
      .eq("phase_id", phaseId)
      .in("position", toDelete);
    if (dErr) throw dErr;
  }

  for (const c of checks) {
    const existingId = byPosition.get(c.position);
    if (existingId) {
      const { error: uErr } = await admin
        .from("spec_phase_checks")
        .update({ description: c.description, kind: c.kind, updated_at: new Date().toISOString() })
        .eq("id", existingId);
      if (uErr) throw uErr;
    } else {
      const { error: iErr } = await admin.from("spec_phase_checks").insert({
        phase_id: phaseId,
        position: c.position,
        description: c.description,
        kind: c.kind,
      });
      if (iErr) throw iErr;
    }
  }
}

export async function listPhaseChecks(phaseId: string): Promise<SpecPhaseCheckRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spec_phase_checks")
    .select("id, phase_id, position, description, kind, created_at, updated_at")
    .eq("phase_id", phaseId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data as SpecPhaseCheckRow[]) ?? [];
}

/**
 * Best-effort backfill helper: split a free-text verification blob into per-check rows. Splits on
 * bullet lines (`- ` / `* `); an empty blob returns []. `kind` defaults to `auto` (the safe default —
 * the spec-test agent will re-classify to human when it can't run the check).
 */
export function parseVerificationBlobToChecks(blob: string | null | undefined): SpecPhaseCheckInput[] {
  if (!blob || !blob.trim()) return [];
  const out: SpecPhaseCheckInput[] = [];
  let cur: string[] | null = null;
  const push = () => {
    if (!cur) return;
    const text = cur.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push({ position: out.length + 1, description: text, kind: "auto" });
    cur = null;
  };
  for (const raw of blob.split("\n")) {
    const line = raw.trim();
    if (!line) { push(); continue; }
    if (/^[-*]\s+/.test(line)) {
      push();
      cur = [line.replace(/^[-*]\s+/, "")];
    } else if (cur) {
      cur.push(line);
    } else {
      // No leading bullet — treat the whole trimmed line as one check.
      cur = [line];
      push();
    }
  }
  push();
  return out;
}
