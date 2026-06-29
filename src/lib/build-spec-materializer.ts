/**
 * build-spec-materializer — Phase 2 of [[../specs/spec-authoring-writes-db-and-worker-materialize]].
 *
 * Bo (the [[../skills/build-spec]] skill) reads the SPEC ROW, not `docs/brain/specs/{slug}.md`. The box
 * worker's `runBuildJob` calls `materializeSpec` to render the row + its `spec_phases` children to a temp
 * `{cwd}/.box/spec-{slug}.md` and hands the build-spec skill that path. Bo never needs the `.md` on disk
 * under `docs/brain/specs/` — the dual-write mirror commit ([[../specs/spec-authoring-writes-db-and-worker-materialize]]
 * Phase 4) still keeps the markdown readers ([[brain-roadmap]] `parseSpec`) green, but builds source from
 * the DB.
 *
 * NO status emoji on the H1 or phases — content-only, mirroring the [[../specs/spec-status-db-driven]] rule
 * (status is DB-driven; the file the build agent reads carries content, not status). The `## Safety /
 * invariants` and `## Completion criteria` sections aren't yet captured as DB columns ([[../tables/specs]]
 * schema today) — Phase 1's author surfaces extract only summary + phases — so the materialized file omits
 * them. The .md mirror commit on `main` preserves those sections until a follow-up adds the columns.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getSpec, type SpecRow } from "@/lib/specs-table";

/**
 * Render a spec row to disk in the brain-spec markdown shape Bo expects. Returns the absolute path the
 * file was written to. Throws when no `specs` row exists for `(workspaceId, slug)` — the caller is
 * responsible for upstream existence (the build dispatch gate refuses an unknown spec).
 */
export async function materializeSpec(workspaceId: string, slug: string, dir: string): Promise<string> {
  const row = await getSpec(workspaceId, slug);
  if (!row) throw new Error(`materializeSpec: no specs row for workspace ${workspaceId} slug ${slug}`);
  const body = renderSpecRow(row);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `spec-${slug}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

/**
 * Pure renderer (no I/O) — joins `specs` + `spec_phases` into the brain-spec markdown the build-spec skill
 * reads. Exported so tests + the brain page can show the exact shape without disk.
 */
export function renderSpecRow(row: SpecRow): string {
  const parts: string[] = [];

  parts.push(`# ${row.title}`, "");

  const meta: string[] = [];
  if (row.owner) meta.push(`**Owner:** [[../functions/${row.owner}]]`);
  if (row.parent) meta.push(`**Parent:** ${row.parent}`);
  const headerLine = meta.join(" · ");
  if (headerLine) parts.push(headerLine);

  if (row.blocked_by.length) {
    parts.push(`**Blocked-by:** ${row.blocked_by.map((s) => `[[${s}]]`).join(", ")}`);
  }
  if (meta.length || row.blocked_by.length) parts.push("");

  if (row.summary && row.summary.trim()) {
    parts.push(row.summary.trim(), "");
  }

  row.phases.forEach((phase, i) => {
    const title = (phase.title || "").trim();
    // Canonical phase heading. The build's db-health gate (builder-worker `db-health-spec-body-robust`)
    // and `parseSpec` recognize a phase by a heading that BEGINS with "Phase" (`/^#{2,3}\s+Phase/`).
    // `spec_phases.title` stores a BARE title (e.g. "Add unused marker constant A"), so emit
    // "## Phase N — <title>" unless the stored title already leads with "Phase" (don't double the prefix).
    const heading = /^phase\b/i.test(title) ? title : `Phase ${i + 1} — ${title}`;
    parts.push(`## ${heading}`);
    if (phase.body && phase.body.trim()) parts.push(phase.body.trim());
    parts.push("");
    if (phase.verification && phase.verification.trim()) {
      parts.push("### Verification", phase.verification.trim(), "");
    }
  });

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
