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
 * file was written to AND the `SpecRow` it rendered from. Throws when no `specs` row exists for
 * `(workspaceId, slug)` — the caller is responsible for upstream existence (the build dispatch gate
 * refuses an unknown spec).
 *
 * The `row` is returned so the build gate can validate on the DB ROW (phases / summary), NOT a regex over
 * the rendered markdown — "the database is the spec." The markdown is a render for Bo to READ, never the
 * validation source. See `specHasBuildableContent`.
 */
export async function materializeSpec(
  workspaceId: string,
  slug: string,
  dir: string,
): Promise<{ path: string; row: SpecRow }> {
  const row = await getSpec(workspaceId, slug);
  if (!row) throw new Error(`materializeSpec: no specs row for workspace ${workspaceId} slug ${slug}`);
  // verification-checks-source-of-truth — render `### Verification` from the typed spec_phase_checks rows
  // (the DB object), column-fallback per phase. Proven checkKey-stable so Vera/green/regression are unchanged.
  const { checksByPhaseIdForRender } = await import("@/lib/spec-phase-checks-table");
  const checksByPhaseId = await checksByPhaseIdForRender(row.phases.map((p) => p.id).filter(Boolean));
  const body = renderSpecRow(row, checksByPhaseId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `spec-${slug}.md`);
  writeFileSync(path, body, "utf8");
  return { path, row };
}

/**
 * DB-row buildability check — "the database is the spec." A spec ROW is buildable iff it carries REAL
 * content on the rows themselves (NOT a magic markdown heading):
 *   - ≥1 `spec_phases` row with a non-empty title OR body (a multi-phase spec), OR
 *   - a non-empty `summary` (a one-shot spec — the whole thing ships in one PR).
 * Only a genuinely-empty spec (no phase carries any title/body AND no summary) is refused. This is the
 * exact safety the old `/^#{2,3}\s+Phase/` markdown regex provided (never build a 0-content spec → never
 * open an empty PR), re-keyed onto the ROWS so a valid spec whose phase titles don't literally start with
 * "Phase" still builds. The existence of the row means it exists — no magic phrases or markdown needed.
 */
export function specHasBuildableContent(row: SpecRow): boolean {
  const hasPhaseContent = row.phases.some(
    (p) => (p.title || "").trim().length > 0 || (p.body || "").trim().length > 0,
  );
  const hasSummary = !!(row.summary && row.summary.trim().length > 0);
  return hasPhaseContent || hasSummary;
}

/** Human-readable reason a row is NOT buildable — for the gate's failure message. "" = buildable. */
export function unbuildableReason(row: SpecRow): string {
  if (specHasBuildableContent(row)) return "";
  if (row.phases.length === 0) return "has no spec_phases rows and an empty summary";
  return "has spec_phases rows but every one is empty (no title, no body) and the summary is empty";
}

/**
 * Pure renderer (no I/O) — joins `specs` + `spec_phases` into the brain-spec markdown the build-spec skill
 * reads. Exported so tests + the brain page can show the exact shape without disk.
 *
 * verification-checks-source-of-truth: `### Verification` is rendered FROM the typed `spec_phase_checks`
 * rows when supplied (`checksByPhaseId`, keyed by `spec_phases.id`, in position order) — the DB objects are
 * the source of truth and this render just ADDS the `- ` + `### Verification` markdown. Falls back to the
 * `spec_phases.verification` text column when a phase has no rows (legacy / not-yet-backfilled). Proven
 * `checkKey`-stable across all 928 phases (scripts/_prove-checkkey-stable-render-flip.ts): `checkKey`
 * normalizes whitespace, so rendering `- {description}` yields the identical key set Vera/green/regression
 * already match on. Called without the map (e.g. spec-chat grounding) it renders from the column exactly as
 * before — fully backward compatible.
 */
export function renderSpecRow(
  row: SpecRow,
  checksByPhaseId?: Map<string, { description: string }[]>,
): string {
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

  // render-spec-row-emits-stored-why-what-intent Phase 1 — surface the plain-language intent the DB already
  // stores (specs.why / specs.what) so Vale + humans reading the materialized markdown SEE it. A fully-
  // authored spec whose intent lives only in the columns was being bounced needs_fix for 'missing intent';
  // this emits the lines directly above the summary so the review agent + humans see the structured intent.
  //
  // Phase 2 — NO DOUBLE EMIT. Some already-shipped specs baked `**Why:**`/`**What:**` into the summary body
  // as a stopgap (e.g. marco-logistics-director-seat, director-chat-in-leash-execution). If the summary
  // already contains a leading `**Why:**` line, skip the column-sourced spec-level Why (same for What) so
  // the render carries exactly one of each — the inline stopgap wins over the column until the author
  // migrates the intent up to the columns.
  const summaryHasLeadingWhy = !!row.summary && /^\*\*Why:\*\*/m.test(row.summary);
  const summaryHasLeadingWhat = !!row.summary && /^\*\*What:\*\*/m.test(row.summary);
  const emitSpecWhy = !!(row.why && row.why.trim()) && !summaryHasLeadingWhy;
  const emitSpecWhat = !!(row.what && row.what.trim()) && !summaryHasLeadingWhat;
  if (emitSpecWhy) parts.push(`**Why:** ${row.why!.trim()}`);
  if (emitSpecWhat) parts.push(`**What:** ${row.what!.trim()}`);
  if (emitSpecWhy || emitSpecWhat) parts.push("");

  if (row.summary && row.summary.trim()) {
    parts.push(row.summary.trim(), "");
  }

  row.phases.forEach((phase, i) => {
    const title = (phase.title || "").trim();
    // Canonical phase heading — kept for Bo's READABILITY + `parseSpec`'s markdown-mirror reader, NOT for
    // validation. The build gate validates on the DB ROW (`specHasBuildableContent`), so this heading is no
    // longer load-bearing: a phase whose title doesn't start with "Phase" still builds. `spec_phases.title`
    // stores a BARE title (e.g. "Add unused marker constant A"), so emit "## Phase N — <title>" unless the
    // stored title already leads with "Phase" (don't double the prefix).
    const heading = /^phase\b/i.test(title) ? title : `Phase ${i + 1} — ${title}`;
    parts.push(`## ${heading}`);
    // render-spec-row-emits-stored-why-what-intent Phase 1 — per-phase intent from spec_phases.why / .what,
    // emitted BEFORE the body so the review agent sees the structured intent alongside the technical detail.
    // Phase 2 — same no-double-emit rule per phase: if the phase body already leads with `**Why:**` (or
    // `**What:**`), skip the column-sourced line for that phase so we render exactly one of each.
    const bodyHasLeadingWhy = !!phase.body && /^\*\*Why:\*\*/m.test(phase.body);
    const bodyHasLeadingWhat = !!phase.body && /^\*\*What:\*\*/m.test(phase.body);
    if (phase.why && phase.why.trim() && !bodyHasLeadingWhy) parts.push(`**Why:** ${phase.why.trim()}`);
    if (phase.what && phase.what.trim() && !bodyHasLeadingWhat) parts.push(`**What:** ${phase.what.trim()}`);
    if (phase.body && phase.body.trim()) parts.push(phase.body.trim());
    parts.push("");
    // Prefer the typed checks (the DB object); fall back to the legacy `verification` column.
    const checks = checksByPhaseId?.get(phase.id)?.filter((c) => c.description && c.description.trim());
    if (checks && checks.length) {
      parts.push("### Verification", checks.map((c) => `- ${c.description.trim()}`).join("\n"), "");
    } else if (phase.verification && phase.verification.trim()) {
      parts.push("### Verification", phase.verification.trim(), "");
    }
  });

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
