// backfill-spec-status-from-markdown — spec-status-db-driven Phase 1 one-time backfill.
//
// Reads every docs/brain/specs/*.md, parses the H1 / phase emojis / **Deferred:** / **Priority:**
// markers the same way `brain-roadmap.parseSpec` does, and upserts one `spec_card_state` row per
// (workspace, spec_slug) with status / phase_states / flags.critical / flags.deferred filled in.
// Records one 'backfill' actor row per spec in `spec_status_history` (skipped on re-run).
//
//   Dry run (default):  npx tsx scripts/backfill-spec-status-from-markdown.ts
//   Apply:              npx tsx scripts/backfill-spec-status-from-markdown.ts --apply
//
// Idempotent: re-running on stable markdown is a no-op. Multi-workspace safe — iterates every workspace.
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const SPECS_DIR = resolve(__dirname, "../docs/brain/specs");

type Phase = "planned" | "in_progress" | "shipped" | "rejected";
type SpecStatus = Phase | "deferred";

function statusFromText(s: string): Phase | null {
  if (s.includes("❌")) return "rejected";
  if (s.includes("🚧")) return "in_progress";
  if (s.includes("⏳")) return "planned";
  if (s.includes("✅")) return "shipped";
  return null;
}

function cleanTitle(s: string): string {
  return s
    .replace(/[⏳🚧✅❌]/g, "")
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alias) => alias || link)
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedSpec {
  slug: string;
  rolledStatus: Phase; // phase rollup that goes into spec_card_state.status (never 'deferred')
  effectiveStatus: SpecStatus; // for logging only
  critical: boolean;
  deferred: boolean;
  phaseStates: { index: number; title: string; status: Phase }[];
}

function parseMarkdown(slug: string, raw: string): ParsedSpec {
  const lines = raw.split("\n");
  let titleStatus: Phase | null = null;
  const titleLine = lines.find((l) => l.startsWith("# "));
  if (titleLine) titleStatus = statusFromText(titleLine);

  const phases: { title: string; status: Phase }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(Phase\b.*)/);
    if (!m) continue;
    let st = statusFromText(lines[i]);
    if (!st) {
      for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) {
        st = statusFromText(lines[j]);
        if (st) break;
      }
    }
    phases.push({ title: cleanTitle(m[1]), status: st ?? "planned" });
  }
  if (phases.length === 0) {
    let inPhases = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Phases?\s*$/i.test(lines[i])) { inPhases = true; continue; }
      if (inPhases && lines[i].startsWith("## ")) break;
      if (!inPhases) continue;
      const bm = lines[i].match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (!bm) continue;
      const st = statusFromText(lines[i]);
      if (!st) continue;
      phases.push({ title: cleanTitle(bm[1]), status: st });
    }
  }

  const counts: Record<Phase, number> = { planned: 0, in_progress: 0, shipped: 0, rejected: 0 };
  for (const p of phases) counts[p.status]++;

  const deferred = lines.some(
    (l) => /^\s*\*\*Deferred:\*\*/i.test(l) || /^\s*\*\*Status:\*\*\s*deferred\b/i.test(l),
  );
  const critical = lines.some((l) => /^\s*\*\*Priority:\*\*\s*critical\b/i.test(l));

  // Mirror `deriveStatus` (brain-roadmap.ts) — but separate the phase rollup (what we store in
  // spec_card_state.status) from the effective status (deferred-aware, used for logging only).
  let rolledStatus: Phase;
  const totalPhases = counts.planned + counts.in_progress + counts.shipped + counts.rejected;
  if (totalPhases > 0 && counts.planned === 0 && counts.in_progress === 0 && titleStatus !== "rejected") {
    rolledStatus = "shipped";
  } else if (titleStatus && titleStatus !== "rejected") {
    rolledStatus = titleStatus;
  } else if (counts.in_progress > 0) {
    rolledStatus = "in_progress";
  } else if (counts.planned > 0) {
    rolledStatus = "planned";
  } else if (counts.shipped > 0 || counts.rejected > 0) {
    rolledStatus = "shipped";
  } else {
    rolledStatus = "planned";
  }
  const effectiveStatus: SpecStatus = deferred ? "deferred" : rolledStatus;

  return {
    slug,
    rolledStatus,
    effectiveStatus,
    critical,
    deferred,
    phaseStates: phases.map((p, i) => ({ index: i, title: p.title, status: p.status })),
  };
}

interface ExistingRow {
  status?: Phase;
  flags?: { critical?: boolean; deferred?: boolean; [k: string]: boolean | undefined };
  phase_states?: { index: number; title: string; status: Phase }[];
}

async function main() {
  const files = readdirSync(SPECS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  const parsed: ParsedSpec[] = files.map((f) => parseMarkdown(f.replace(/\.md$/, ""), readFileSync(resolve(SPECS_DIR, f), "utf8")));

  console.log(`Parsed ${parsed.length} specs from ${SPECS_DIR}`);

  const admin = createAdminClient();
  const { data: workspaces, error: wsErr } = await admin.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;
  console.log(`Found ${(workspaces ?? []).length} workspace(s)`);

  for (const ws of workspaces ?? []) {
    console.log(`\n--- workspace ${ws.id} (${ws.name ?? ""}) ---`);
    for (const spec of parsed) {
      const { data: existingData } = await admin
        .from("spec_card_state")
        .select("status, flags, phase_states")
        .eq("workspace_id", ws.id)
        .eq("spec_slug", spec.slug)
        .maybeSingle();
      const existing = (existingData ?? {}) as ExistingRow;

      // Forward-only on status: if DB is ahead (a merge already shipped a phase), keep it.
      const RANK: Record<Phase, number> = { rejected: -1, planned: 0, in_progress: 1, shipped: 2 };
      const dbStatus = existing.status ?? "planned";
      const finalStatus = RANK[spec.rolledStatus] >= RANK[dbStatus] ? spec.rolledStatus : dbStatus;

      const finalFlags = { ...(existing.flags ?? {}), critical: spec.critical, deferred: spec.deferred };
      const changed =
        !existingData ||
        existing.status !== finalStatus ||
        (existing.flags?.critical ?? false) !== spec.critical ||
        (existing.flags?.deferred ?? false) !== spec.deferred ||
        JSON.stringify(existing.phase_states ?? []) !== JSON.stringify(spec.phaseStates);

      if (!changed) continue;

      console.log(
        `  ${spec.slug}: status=${finalStatus} critical=${spec.critical} deferred=${spec.deferred} phases=${spec.phaseStates.length}` +
          (existingData ? ` (was status=${existing.status} flags.critical=${existing.flags?.critical} flags.deferred=${existing.flags?.deferred})` : " (NEW)"),
      );

      if (!APPLY) continue;

      await admin
        .from("spec_card_state")
        .upsert(
          {
            workspace_id: ws.id,
            spec_slug: spec.slug,
            status: finalStatus,
            flags: finalFlags,
            phase_states: spec.phaseStates,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,spec_slug" },
        );

      // Dedup history: a backfill row already present for this slug means we already backfilled it.
      const { data: prior } = await admin
        .from("spec_status_history")
        .select("id")
        .eq("workspace_id", ws.id)
        .eq("spec_slug", spec.slug)
        .eq("actor", "backfill")
        .limit(1);
      if (!prior || !prior.length) {
        await admin.from("spec_status_history").insert([
          {
            workspace_id: ws.id,
            spec_slug: spec.slug,
            field: "status",
            from_value: existingData ? JSON.stringify(existing.status ?? null) : null,
            to_value: JSON.stringify(finalStatus),
            actor: "backfill",
            reason: "spec-status-db-driven Phase 1 backfill from markdown",
          },
          {
            workspace_id: ws.id,
            spec_slug: spec.slug,
            field: "critical",
            from_value: existingData ? JSON.stringify(existing.flags?.critical ?? null) : null,
            to_value: JSON.stringify(spec.critical),
            actor: "backfill",
            reason: "spec-status-db-driven Phase 1 backfill from markdown",
          },
          {
            workspace_id: ws.id,
            spec_slug: spec.slug,
            field: "deferred",
            from_value: existingData ? JSON.stringify(existing.flags?.deferred ?? null) : null,
            to_value: JSON.stringify(spec.deferred),
            actor: "backfill",
            reason: "spec-status-db-driven Phase 1 backfill from markdown",
          },
        ]).then(undefined, () => {}); // best-effort — history table may not exist yet
      }
    }
  }

  console.log(`\n${APPLY ? "✓ backfill applied" : "(dry run — pass --apply to write)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
