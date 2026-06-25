// backfill-specs-from-markdown — db-driven-specs M1 / [[spec-body-table-and-backfill]] Phase 3.
//
// One-time backfill: read every `docs/brain/specs/*.md`, run the existing brain-roadmap `parseSpec`
// ONE LAST TIME, and INSERT/UPDATE matching rows into `public.specs` + `public.spec_phases`. Per workspace.
//
//   Dry run (default):  npx tsx scripts/backfill-specs-from-markdown.ts
//   Apply:              npx tsx scripts/backfill-specs-from-markdown.ts --apply
//
// Status / per-phase status / **Priority:** critical / **Deferred:** parked / `flags.intended_status` come
// from the live spec_card_state mirror when present (spec-status-db-driven made the DB authoritative for
// those). Per-phase status carries the forward-merge guard from `overlayDbStateOnSpec`: when the markdown
// is AHEAD of the mirror (a fresh edit the mirror hasn't caught), markdown wins so a fresh disk edit isn't
// backfilled OVER by a stale board state.
//
// Idempotent + resumable: UPSERTs `specs` by `(workspace_id, slug)`; phase replacement is by `(spec_id,
// position)` (the same id-by-position rule the `upsertSpec` lib uses). Re-running on stable state is a
// no-op (only the `updated_at` bumps).
//
// After --apply: walks every `specs` row and flags any whose rolled-up `status` doesn't match the
// expected source value (spec_card_state.status, or the markdown parse where no mirror exists) for human
// review — does NOT silently overwrite.
//
// Out of scope: deleting `docs/brain/specs/*.md` files (the .md stays authoritative until
// `spec-readers-from-db-retire-parser` retires the parser); rewiring readers/writers.
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";
import { parseSpec, type SpecCard, type Phase, type SpecStatus } from "../src/lib/brain-roadmap";
import { upsertSpec, type SpecPhaseInput, type SpecStatus as DbSpecStatus } from "../src/lib/specs-table";
import {
  extractPhaseBodies,
  extractRepairSignature,
  extractRegressionHeaders,
} from "../src/lib/author-spec";

const APPLY = process.argv.includes("--apply");
const SPECS_DIR = resolve(__dirname, "../docs/brain/specs");
const PHASE_RANK: Record<Phase, number> = { rejected: -1, planned: 0, in_progress: 1, shipped: 2 };

interface PhaseStateRow {
  index: number;
  title: string;
  status: Phase;
  pr?: number | null;
  merge_sha?: string | null;
}

interface CardStateRow {
  spec_slug: string;
  status: SpecStatus;
  phase_states: PhaseStateRow[] | null;
  flags: Record<string, boolean | string | number | undefined> | null;
}

interface Workspace {
  id: string;
  name: string | null;
}

// extractPhaseBodies / extractRepairSignature / extractRegressionHeaders moved to ../src/lib/author-spec.ts
// (the shared helper used by every author surface in builder-worker for the dual-write — Phase 1 of
// [[spec-authoring-writes-db-and-worker-materialize]]). Importing keeps a single source of truth so the
// backfill + the live writers can't drift.

/** Map a `SpecStatus` from the markdown/mirror to the `specs.status` DB enum.
 *  Markdown can yield `planned | in_progress | shipped | deferred | in_review`; the DB also accepts
 *  `folded` (set elsewhere, not by parseSpec). `rejected` is a phase-only state and never appears as a
 *  whole-spec board column — fall back to `planned`. */
function toDbStatus(s: SpecStatus | undefined): DbSpecStatus | undefined {
  if (!s) return undefined;
  if (s === "rejected") return "planned";
  return s as DbSpecStatus;
}

/** Per-phase forward-merge: prefer the markdown phase when it's AHEAD of the DB mirror (a fresh disk
 *  edit), preserving the mirror's pr/merge_sha when the DB is at-or-ahead. Same rule as
 *  `overlayDbStateOnSpec` in brain-roadmap. */
function mergePhase(
  markdown: { status: Phase },
  dbPhase: PhaseStateRow | undefined,
): { status: Phase; pr: number | null | undefined; merge_sha: string | null | undefined } {
  if (!dbPhase) return { status: markdown.status, pr: undefined, merge_sha: undefined };
  // Markdown wins if it's MORE advanced — drop stale DB provenance with it.
  if (PHASE_RANK[markdown.status] > PHASE_RANK[dbPhase.status]) {
    return { status: markdown.status, pr: undefined, merge_sha: undefined };
  }
  return { status: dbPhase.status, pr: dbPhase.pr ?? null, merge_sha: dbPhase.merge_sha ?? null };
}

async function main() {
  const files = readdirSync(SPECS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  console.log(`Parsing ${files.length} spec file(s) from ${SPECS_DIR}`);

  const cards = new Map<string, { card: SpecCard; raw: string; phaseBodies: { title: string; body: string }[] }>();
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const raw = readFileSync(resolve(SPECS_DIR, f), "utf8");
    const card = parseSpec(slug, raw);
    const phaseBodies = extractPhaseBodies(raw);
    cards.set(slug, { card, raw, phaseBodies });
  }

  const admin = createAdminClient();
  const { data: workspacesData, error: wsErr } = await admin.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;
  const workspaces = (workspacesData ?? []) as Workspace[];
  console.log(`Found ${workspaces.length} workspace(s)`);

  const mismatchedAfterApply: { workspace: string; slug: string; expected: string; got: string }[] = [];
  let totalUpserts = 0;

  for (const ws of workspaces) {
    console.log(`\n--- workspace ${ws.id} (${ws.name ?? ""}) ---`);
    const { data: states, error: stErr } = await admin
      .from("spec_card_state")
      .select("spec_slug, status, phase_states, flags")
      .eq("workspace_id", ws.id);
    if (stErr) throw stErr;
    const stateBySlug = new Map<string, CardStateRow>();
    for (const r of (states ?? []) as CardStateRow[]) stateBySlug.set(r.spec_slug, r);

    for (const [slug, { card, phaseBodies }] of cards) {
      const state = stateBySlug.get(slug);
      // DB-mirror flags WIN for the board signals (spec-status-db-driven).
      const flagsCritical = state?.flags?.critical === true;
      const flagsDeferred = state?.flags?.deferred === true;
      const flagsIntendedRaw = state?.flags?.intended_status;
      const intendedStatus: "planned" | "deferred" | null =
        flagsIntendedRaw === "planned" || flagsIntendedRaw === "deferred" ? flagsIntendedRaw : null;

      // Markdown-derived flags as fallback.
      const mdCritical = !!card.critical;
      const mdDeferred = card.status === "deferred";

      const priority: string | null = state ? (flagsCritical ? "critical" : null) : mdCritical ? "critical" : null;
      const deferred: boolean = state ? flagsDeferred : mdDeferred;

      // Status: DB-mirror wins when present; markdown otherwise. `deferred` flag wins for board display.
      const effective: SpecStatus = state
        ? (flagsDeferred ? "deferred" : state.status)
        : card.status;
      const status = toDbStatus(effective);

      const phaseStateByIndex = new Map<number, PhaseStateRow>();
      for (const p of state?.phase_states ?? []) phaseStateByIndex.set(p.index, p);

      // Phase position is 1-indexed in the table; parser+body extractor index 0..N-1.
      const phases: SpecPhaseInput[] = card.phases.map((p, i) => {
        const merged = mergePhase(p, phaseStateByIndex.get(i));
        const body = phaseBodies[i]?.body ?? "";
        return {
          position: i + 1,
          title: p.title,
          body,
          status: merged.status,
          // PASS undefined to PRESERVE existing pr/merge_sha on update; null to clear (we use undefined
          // when markdown is ahead so an existing stale provenance gets cleared explicitly via empty pass).
          pr: merged.pr,
          merge_sha: merged.merge_sha,
        };
      });

      console.log(
        `  ${slug}: ${phases.length} phase(s) status=${status ?? "(default)"}${deferred ? " deferred" : ""}${priority ? " critical" : ""}`,
      );

      if (!APPLY) continue;
      totalUpserts++;
      const rawMd = readFileSync(resolve(SPECS_DIR, `${slug}.md`), "utf8");
      const regressionHeaders = extractRegressionHeaders(rawMd);
      await upsertSpec(
        ws.id,
        {
          slug,
          title: card.title,
          summary: card.summary || null,
          owner: card.owner ?? "",
          parent: card.parent ?? "",
          blocked_by: (card.blockedBy ?? []).map((b) => b.slug),
          priority,
          deferred,
          intended_status: intendedStatus,
          status,
          intended_status_set_by: null,
          repair_signature: extractRepairSignature(rawMd),
          regression_of_slug: regressionHeaders.ofSlug,
          regression_signature: regressionHeaders.signature,
          auto_build: card.autoBuild === true,
          milestone_id: null,
        },
        phases,
      );

      // Verify rolled-up status matches the expected source value. The trigger may have flipped it
      // (e.g. all-shipped phases override a markdown that the parser misread); we surface any divergence.
      const { data: persisted } = await admin
        .from("specs")
        .select("status")
        .eq("workspace_id", ws.id)
        .eq("slug", slug)
        .maybeSingle();
      const got = (persisted as { status?: string } | null)?.status ?? "";
      const expected = status ?? "in_review";
      if (got && got !== expected && got !== "in_review" && got !== "folded") {
        // The trigger rolled to something other than what the mirror/markdown claimed — keep the
        // trigger's answer (it's read from authoritative phases) but flag for human review per the spec.
        mismatchedAfterApply.push({ workspace: ws.id, slug, expected, got });
      }
    }
  }

  console.log("");
  if (!APPLY) {
    console.log(`(dry run — pass --apply to write. Would upsert across ${workspaces.length} workspace(s).)`);
    return;
  }
  console.log(`✓ ${totalUpserts} spec(s) upserted across ${workspaces.length} workspace(s)`);
  if (mismatchedAfterApply.length) {
    console.log(`\n⚠️  ${mismatchedAfterApply.length} spec(s) had a status mismatch between source and rolled-up DB value:`);
    for (const m of mismatchedAfterApply) {
      console.log(`   workspace=${m.workspace} slug=${m.slug} expected=${m.expected} got=${m.got}`);
    }
    console.log(`   → review per [[spec-body-table-and-backfill]] completion criteria; do NOT silently overwrite.`);
  } else {
    console.log("✓ rolled-up specs.status matches the source value for every spec.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
