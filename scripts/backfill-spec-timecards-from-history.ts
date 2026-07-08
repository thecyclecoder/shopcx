/**
 * backfill-spec-timecards-from-history — reconstruct the [[spec_timecard_events]] ledger for
 * specs authored BEFORE Mario's Phase-1 table shipped, so the M3 detector cron + the M5
 * detail-page timeline have history to read.
 *
 * Two-phase: dry-run by default, `--apply` writes. Idempotent — dedupe on
 * (workspace_id, spec_slug, event_kind, at) so a re-run is a no-op. Every reconstructed row
 * carries `actor='backfill'` + `metadata.backfill_source` naming the source table, so a later
 * audit can distinguish reconstructed from real events.
 *
 * Source mapping (see docs/brain/recipes/backfill-spec-timecards.md for the full table):
 *   - specs.created_at                                                → 'created'
 *   - specs.vale_review_passed_at                                     → 'review_passed'
 *   - spec_status_history[field=status, to_value='"in_review"']       → 'review_started'
 *   - spec_status_history[field=status, to_value='"folded"']          → 'folded'
 *   - spec_phases[merge_sha IS NOT NULL].updated_at                   → 'phase_shipped'
 *   - agent_jobs[kind=build, claimed_at NOT NULL].claimed_at          → 'build_started'
 *   - agent_jobs[kind=build, status=completed].updated_at             → 'build_done'
 *   - spec_test_runs.run_at                                           → 'spec_test_verdict'
 *
 * Deliberately skipped:
 *   - wait_entered / wait_exited — no historical source names WHO was waiting on WHOM
 *     (needs_input / needs_approval / dependency / usage waits are a forward-only signal).
 *   - fold_started / fold_done — an `agent_jobs kind='fold'` row's spec_slug is the
 *     `'fold-batch'` sentinel, not the folded spec; the batch-fanout mapping is not
 *     reliably reconstructable. `folded` (from the spec_status_history transition) is
 *     the terminal marker; the started/done pair belongs to the fold job, not the spec.
 *   - review_failed — the current Vale schema has no durable "review failed" stamp on
 *     specs; only `vale_pass=false` (the transient tri-state) survives, and that gets
 *     cleared on re-author. A future signal (director_activity kind, once wired) can add
 *     this without a schema change.
 *
 * Resilience: each source read is wrapped in its own try/catch so ONE flaky source-table
 * query (a schema drift on a rarely-used column, a Supabase timeout) doesn't wipe the
 * whole backfill — the script logs the source that failed + continues with the rest. A
 * partial backfill re-runs cleanly (idempotent dedupe).
 *
 * Run:
 *   npx tsx scripts/backfill-spec-timecards-from-history.ts             # dry-run (default)
 *   npx tsx scripts/backfill-spec-timecards-from-history.ts --apply     # write
 *   npx tsx scripts/backfill-spec-timecards-from-history.ts --workspace=<uuid> [--apply]
 */
import { createAdminClient } from "./_bootstrap";

const PAGE = 1000;
const INSERT_BATCH = 500;

type Admin = ReturnType<typeof createAdminClient>;

type ProposedRow = {
  workspace_id: string;
  spec_slug: string;
  phase_index: number | null;
  event_kind: string;
  actor: "backfill";
  at: string;
  metadata: Record<string, unknown>;
};

function keyOf(r: { spec_slug: string; event_kind: string; at: string }): string {
  return `${r.spec_slug}|${r.event_kind}|${r.at}`;
}

/** Run a source-table reader and swallow its errors — a partial backfill is better than none. */
async function safe<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`  ! source '${name}' failed: ${(e as Error).message} — skipping this source`);
    return fallback;
  }
}

async function readExistingBackfillKeys(admin: Admin, workspace_id: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("spec_timecard_events")
      .select("spec_slug, event_kind, at")
      .eq("workspace_id", workspace_id)
      .eq("actor", "backfill")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`spec_timecard_events read failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      keys.add(keyOf({ spec_slug: String(r.spec_slug), event_kind: String(r.event_kind), at: String(r.at) }));
    }
    if (data.length < PAGE) break;
  }
  return keys;
}

async function readSpecs(admin: Admin, workspace_id: string): Promise<{
  proposed: ProposedRow[];
  slugById: Map<string, string>;
}> {
  const proposed: ProposedRow[] = [];
  const slugById = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("specs")
      .select("id, slug, created_at, vale_review_passed_at")
      .eq("workspace_id", workspace_id)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`specs read failed: ${error.message}`);
    if (!data?.length) break;
    for (const s of data) {
      const slug = String(s.slug ?? "");
      if (!slug) continue;
      slugById.set(String(s.id), slug);
      if (s.created_at) {
        proposed.push({
          workspace_id,
          spec_slug: slug,
          phase_index: null,
          event_kind: "created",
          actor: "backfill",
          at: String(s.created_at),
          metadata: { backfill_source: "specs.created_at" },
        });
      }
      if (s.vale_review_passed_at) {
        proposed.push({
          workspace_id,
          spec_slug: slug,
          phase_index: null,
          event_kind: "review_passed",
          actor: "backfill",
          at: String(s.vale_review_passed_at),
          metadata: { backfill_source: "specs.vale_review_passed_at" },
        });
      }
    }
    if (data.length < PAGE) break;
  }
  return { proposed, slugById };
}

async function readStatusHistory(admin: Admin, workspace_id: string): Promise<ProposedRow[]> {
  const proposed: ProposedRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("spec_status_history")
      .select("spec_slug, field, to_value, actor, at")
      .eq("workspace_id", workspace_id)
      .eq("field", "status")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`spec_status_history read failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      const slug = String(r.spec_slug ?? "");
      if (!slug || !r.at) continue;
      const to = String(r.to_value ?? "");
      if (to === '"in_review"') {
        proposed.push({
          workspace_id,
          spec_slug: slug,
          phase_index: null,
          event_kind: "review_started",
          actor: "backfill",
          at: String(r.at),
          metadata: { backfill_source: "spec_status_history[status→in_review]" },
        });
      } else if (to === '"folded"') {
        proposed.push({
          workspace_id,
          spec_slug: slug,
          phase_index: null,
          event_kind: "folded",
          actor: "backfill",
          at: String(r.at),
          metadata: { backfill_source: "spec_status_history[status→folded]" },
        });
      }
    }
    if (data.length < PAGE) break;
  }
  return proposed;
}

async function readPhases(
  admin: Admin,
  workspace_id: string,
  slugById: Map<string, string>,
): Promise<ProposedRow[]> {
  const proposed: ProposedRow[] = [];
  const specIds = [...slugById.keys()];
  // Guard: `.in("spec_id", [])` errors on some PostgREST versions — a workspace with zero
  // specs has no phases to backfill.
  if (specIds.length === 0) return proposed;
  for (let i = 0; i < specIds.length; i += PAGE) {
    const batch = specIds.slice(i, i + PAGE);
    if (batch.length === 0) continue;
    // Paginate the phases-per-batch too — a large workspace can have >1000 shipped phases,
    // which would silently truncate at Supabase's default row cap otherwise.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from("spec_phases")
        .select("spec_id, position, merge_sha, updated_at, pr")
        .in("spec_id", batch)
        .not("merge_sha", "is", null)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`spec_phases read failed: ${error.message}`);
      if (!data?.length) break;
      for (const p of data) {
        const slug = slugById.get(String(p.spec_id));
        if (!slug || !p.updated_at) continue;
        proposed.push({
          workspace_id,
          spec_slug: slug,
          phase_index: p.position != null ? Number(p.position) : null,
          event_kind: "phase_shipped",
          actor: "backfill",
          at: String(p.updated_at),
          metadata: {
            backfill_source: "spec_phases[merge_sha≠null].updated_at",
            merge_sha: p.merge_sha,
            pr: p.pr,
          },
        });
      }
      if (data.length < PAGE) break;
    }
  }
  return proposed;
}

async function readBuildJobs(admin: Admin, workspace_id: string): Promise<ProposedRow[]> {
  const proposed: ProposedRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("agent_jobs")
      .select("spec_slug, claimed_at, updated_at, status")
      .eq("workspace_id", workspace_id)
      .eq("kind", "build")
      .not("claimed_at", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`agent_jobs[kind=build] read failed: ${error.message}`);
    if (!data?.length) break;
    for (const j of data) {
      const slug = String(j.spec_slug ?? "");
      if (!slug) continue;
      if (j.claimed_at) {
        proposed.push({
          workspace_id,
          spec_slug: slug,
          phase_index: null,
          event_kind: "build_started",
          actor: "backfill",
          at: String(j.claimed_at),
          metadata: { backfill_source: "agent_jobs[kind=build].claimed_at" },
        });
      }
      if (j.status === "completed" && j.updated_at) {
        proposed.push({
          workspace_id,
          spec_slug: slug,
          phase_index: null,
          event_kind: "build_done",
          actor: "backfill",
          at: String(j.updated_at),
          metadata: { backfill_source: "agent_jobs[kind=build,status=completed].updated_at" },
        });
      }
    }
    if (data.length < PAGE) break;
  }
  return proposed;
}

async function readSpecTestRuns(admin: Admin, workspace_id: string): Promise<ProposedRow[]> {
  const proposed: ProposedRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("spec_test_runs")
      .select("spec_slug, run_at, agent_verdict")
      .eq("workspace_id", workspace_id)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`spec_test_runs read failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      const slug = String(r.spec_slug ?? "");
      if (!slug || !r.run_at) continue;
      proposed.push({
        workspace_id,
        spec_slug: slug,
        phase_index: null,
        event_kind: "spec_test_verdict",
        actor: "backfill",
        at: String(r.run_at),
        metadata: {
          backfill_source: "spec_test_runs.run_at",
          verdict: r.agent_verdict,
        },
      });
    }
    if (data.length < PAGE) break;
  }
  return proposed;
}

async function backfillOneWorkspace(
  admin: Admin,
  workspace_id: string,
  apply: boolean,
): Promise<{ existing: number; proposed: number; inserted: number }> {
  console.log(`workspace ${workspace_id}: reading existing backfill snapshot …`);
  const existingKeys = await readExistingBackfillKeys(admin, workspace_id);
  console.log(`  existing backfill rows: ${existingKeys.size}`);

  console.log(`  reading specs …`);
  const specsResult = await safe(
    "specs",
    () => readSpecs(admin, workspace_id),
    { proposed: [] as ProposedRow[], slugById: new Map<string, string>() },
  );
  console.log(`    specs → ${specsResult.proposed.length} event(s), ${specsResult.slugById.size} spec(s) mapped`);

  console.log(`  reading spec_status_history …`);
  const statusRows = await safe("spec_status_history", () => readStatusHistory(admin, workspace_id), []);
  console.log(`    spec_status_history → ${statusRows.length} event(s)`);

  console.log(`  reading spec_phases …`);
  const phaseRows = await safe(
    "spec_phases",
    () => readPhases(admin, workspace_id, specsResult.slugById),
    [],
  );
  console.log(`    spec_phases → ${phaseRows.length} event(s)`);

  console.log(`  reading agent_jobs[build] …`);
  const buildRows = await safe("agent_jobs[build]", () => readBuildJobs(admin, workspace_id), []);
  console.log(`    agent_jobs[build] → ${buildRows.length} event(s)`);

  console.log(`  reading spec_test_runs …`);
  const testRows = await safe("spec_test_runs", () => readSpecTestRuns(admin, workspace_id), []);
  console.log(`    spec_test_runs → ${testRows.length} event(s)`);

  const proposed: ProposedRow[] = [
    ...specsResult.proposed,
    ...statusRows,
    ...phaseRows,
    ...buildRows,
    ...testRows,
  ];

  // Dedupe: (a) against DB (existingKeys), (b) against ourselves (same-batch dupes).
  const seenInBatch = new Set<string>();
  const toInsert: ProposedRow[] = [];
  for (const row of proposed) {
    const k = keyOf(row);
    if (existingKeys.has(k)) continue;
    if (seenInBatch.has(k)) continue;
    seenInBatch.add(k);
    toInsert.push(row);
  }

  console.log(
    `  → workspace ${workspace_id}: proposed=${proposed.length} already-backfilled=${existingKeys.size} to-insert=${toInsert.length}`,
  );

  if (!apply) {
    return { existing: existingKeys.size, proposed: proposed.length, inserted: 0 };
  }

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
    const batch = toInsert.slice(i, i + INSERT_BATCH);
    const { error } = await admin.from("spec_timecard_events").insert(batch);
    if (error) throw new Error(`spec_timecard_events insert failed: ${error.message}`);
    inserted += batch.length;
  }
  console.log(`  ✓ inserted ${inserted} row(s)`);
  return { existing: existingKeys.size, proposed: proposed.length, inserted };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const wsArg = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const admin = createAdminClient();
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}${wsArg ? ` · workspace=${wsArg}` : ""}\n`);

  let workspaces: Array<{ id: string }> = [];
  if (wsArg) {
    workspaces = [{ id: wsArg }];
  } else {
    const { data, error } = await admin.from("workspaces").select("id");
    if (error) throw new Error(`workspaces read failed: ${error.message}`);
    workspaces = (data ?? []) as Array<{ id: string }>;
  }
  console.log(`Workspaces in scope: ${workspaces.length}\n`);

  let totalExisting = 0;
  let totalProposed = 0;
  let totalInserted = 0;
  for (const w of workspaces) {
    try {
      const r = await backfillOneWorkspace(admin, w.id, apply);
      totalExisting += r.existing;
      totalProposed += r.proposed;
      totalInserted += r.inserted;
    } catch (e) {
      console.error(`workspace ${w.id}: FAILED — ${(e as Error).message}`);
      // Continue with next workspace rather than abort the whole run.
    }
    console.log("");
  }

  console.log(
    `Totals: proposed=${totalProposed} already-backfilled=${totalExisting} ${apply ? `inserted=${totalInserted}` : `would-insert=${totalProposed - totalExisting}`}`,
  );
  if (!apply) {
    console.log(
      `\nDry-run only. Re-run with --apply to write the ${totalProposed - totalExisting} new row(s).`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
