/**
 * One-shot reclassification of parked `agent_jobs` rows that point at an already-`shipped` spec
 * but landed with `needs_attention_class` of `unknown` or NULL — the queue noise
 * park-classifier-trust-board-shipped Phase 1 prevents going forward.
 *
 * Pre-Phase-1 the classifier read only the verdict string + a 1-shot Sonnet pass; when a build
 * parked on an already-shipped spec ("Phase 1 was already built end-to-end in #315", "this was a
 * self-watch gate-lift, not a feature delta"), the classifier didn't recognize the phrasing and
 * fell back to `class='unknown'`. Those rows then never reached the Phase 1 auto-fold cron and sat
 * stuck until the 60-minute backstop pulled them into a director investigation — wasted attention.
 *
 * This script reclassifies the existing stuck rows so the standing auto-fold sweep can dismiss
 * them. It's a ONE-OFF — not a recurring script — Phase 1's short-circuit prevents new ones.
 *
 * Read-only by default (prints what WOULD change); pass `--apply` to actually re-stamp
 * `needs_attention_class='already_shipped'` on the matched rows.
 *
 *   npx tsx scripts/reclassify-stuck-shipped-parks.ts            # dry run
 *   npx tsx scripts/reclassify-stuck-shipped-parks.ts --apply    # write
 *
 * NOTE: drops the conventional `_` prefix on purpose — the file is committed (the worker has to
 * be able to run it via the gated-actions flow), and `scripts/_*` is gitignored except for
 * `scripts/_bootstrap.ts`. Naming it without the underscore keeps it tracked without amending the
 * project-wide gitignore. The "one-off" intent is encoded in the filename instead.
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");

interface StuckRow {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string | null;
  needs_attention_class: string | null;
  created_at: string;
  error: string | null;
}

interface CardRow {
  workspace_id: string;
  spec_slug: string;
  status: string;
}

async function main(): Promise<void> {
  const admin = createAdminClient();

  // 1. Pull every `needs_attention` row with a `spec_slug`. We filter for the unknown/NULL class
  //    + presence of a slug in JS to keep the supabase-js query mechanically simple (one `eq`
  //    plus no chained `or` / `not.is.null` — those can produce surprising postgrest fragments
  //    when combined).
  const { data, error } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, needs_attention_class, created_at, error")
    .eq("status", "needs_attention");
  if (error) throw error;
  const allParked = (data ?? []) as StuckRow[];
  const stuck = allParked.filter(
    (r) => !!r.spec_slug && (r.needs_attention_class === null || r.needs_attention_class === "unknown"),
  );
  console.log(`[reclassify] needs_attention rows total: ${allParked.length}`);
  console.log(`[reclassify] of those, with spec_slug and class in (NULL, unknown): ${stuck.length}`);

  if (stuck.length === 0) {
    console.log("[reclassify] nothing to do");
    return;
  }

  // 2. Look up the matching board state per workspace and keep only the rows whose spec is
  //    `shipped` on the board.
  const byWorkspace = new Map<string, Set<string>>();
  for (const row of stuck) {
    if (!row.spec_slug) continue;
    const set = byWorkspace.get(row.workspace_id) ?? new Set<string>();
    set.add(row.spec_slug);
    byWorkspace.set(row.workspace_id, set);
  }

  const shippedKey = new Set<string>(); // `${workspace_id}::${spec_slug}` of shipped specs
  for (const [workspaceId, slugs] of byWorkspace) {
    const { data: cards, error: cardsErr } = await admin
      .from("spec_card_state")
      .select("workspace_id, spec_slug, status")
      .eq("workspace_id", workspaceId)
      .in("spec_slug", Array.from(slugs));
    if (cardsErr) throw cardsErr;
    for (const card of ((cards ?? []) as CardRow[])) {
      if (card.status === "shipped") shippedKey.add(`${card.workspace_id}::${card.spec_slug}`);
    }
  }

  const toReclassify = stuck.filter((r) => r.spec_slug && shippedKey.has(`${r.workspace_id}::${r.spec_slug}`));
  console.log(`[reclassify] stuck-on-shipped rows: ${toReclassify.length}`);
  for (const row of toReclassify) {
    const reason = (row.error ?? "").slice(0, 80).replace(/\s+/g, " ");
    console.log(
      `  ${row.id.slice(0, 8)} kind=${row.kind} slug=${row.spec_slug} class=${row.needs_attention_class ?? "NULL"} created=${row.created_at.slice(0, 16)} reason="${reason}"`,
    );
  }

  if (toReclassify.length === 0) return;

  if (!APPLY) {
    console.log("\n[reclassify] DRY RUN — re-run with --apply to stamp class='already_shipped' on the rows above");
    return;
  }

  // 3. Re-stamp. One UPDATE per row — small, bounded set (handful of rows), idempotent.
  const now = new Date().toISOString();
  let written = 0;
  for (const row of toReclassify) {
    const { error: updErr } = await admin
      .from("agent_jobs")
      .update({ needs_attention_class: "already_shipped", updated_at: now })
      .eq("id", row.id);
    if (updErr) {
      console.error(`  ✗ ${row.id.slice(0, 8)} update failed: ${updErr.message}`);
      continue;
    }
    written += 1;
    console.log(`  ✓ ${row.id.slice(0, 8)} → class='already_shipped'`);
  }
  console.log(`\n[reclassify] applied: ${written} / ${toReclassify.length}`);
  console.log("[reclassify] the Phase 1 auto-fold cron should dismiss these within ~10 min");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
