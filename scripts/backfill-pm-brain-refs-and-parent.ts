/**
 * Backfill pm-structured-intent-and-refs Phase 2 — hydrate spec_brain_refs from the pre-Phase-2
 * `**Brain refs:**` prose line stuffed into `specs.summary`, and populate `specs.parent_kind` +
 * `specs.parent_ref` from the free-text `specs.parent`.
 *
 * Idempotent + read-then-replace: for each spec,
 *   1. Parse the `**Brain refs:**` line out of `specs.summary` (if present) into `{kind}/{name}`
 *      slugs (parseBrainRefsLineToSlugs); replace the spec's spec_brain_refs row set with those.
 *   2. Infer parent_kind/parent_ref from `specs.parent`:
 *      - If `milestone_id` is set → kind='milestone', ref=milestone_id.
 *      - Else if `parent` looks like `[[../functions/{slug}]]` → kind='function', ref=slug.
 *      - Else if `parent` looks like `[[../functions/{slug}]] → …` or contains `#` → kind='mandate',
 *        ref=`{function}#{mandate-slug}` (mandate keys are `function#kebab-name` in the brain).
 *      - Else leave both NULL (legacy shape — the CI enforcer refuses only NEW specs without a typed
 *        parent going forward).
 *
 * DRY-RUN by default (prints the delta); pass `APPLY=1` to write. No prod-mutating write happens
 * without the env flag.
 *
 * Run:
 *   npx tsx scripts/backfill-pm-brain-refs-and-parent.ts               # dry-run
 *   APPLY=1 npx tsx scripts/backfill-pm-brain-refs-and-parent.ts       # write
 */
import { pgClient } from "./_bootstrap";
import { parseBrainRefsLineToSlugs } from "../src/lib/spec-brain-refs-table";

const APPLY = process.env.APPLY === "1";

function inferParent(row: {
  parent: string | null;
  milestone_id: string | null;
}): { kind: "function" | "mandate" | "milestone" | null; ref: string | null } {
  if (row.milestone_id) return { kind: "milestone", ref: row.milestone_id };
  const p = (row.parent ?? "").trim();
  if (!p) return { kind: null, ref: null };
  // `[[../functions/{slug}]] → 'mandate-key'` — mandate.
  const mandateM = p.match(/\[\[\.\.\/functions\/([a-z0-9-]+)\]\][^#]*[→\-]\s*['`"]?([a-z0-9-]+)['`"]?/i);
  if (mandateM) return { kind: "mandate", ref: `${mandateM[1].toLowerCase()}#${mandateM[2].toLowerCase()}` };
  // `[[../functions/{slug}]]` — plain function parent.
  const fnM = p.match(/^\s*\[\[\.\.\/functions\/([a-z0-9-]+)\]\]/i);
  if (fnM) return { kind: "function", ref: fnM[1].toLowerCase() };
  // `function#mandate-key` bare form.
  const bareM = p.match(/^([a-z][a-z0-9-]*)#([a-z][a-z0-9-]*)$/i);
  if (bareM) return { kind: "mandate", ref: p.toLowerCase() };
  return { kind: null, ref: null };
}

function extractBrainRefsLine(summary: string | null): string[] {
  if (!summary) return [];
  for (const line of summary.split("\n")) {
    if (/^\s*\*\*Brain refs:\*\*/i.test(line)) return parseBrainRefsLineToSlugs(line);
  }
  return [];
}

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows: specs } = await c.query<{
      id: string;
      slug: string;
      summary: string | null;
      parent: string | null;
      milestone_id: string | null;
      parent_kind: string | null;
      parent_ref: string | null;
    }>(`
      select id, slug, summary, parent, milestone_id, parent_kind, parent_ref
      from public.specs
    `);
    console.log(`Scanning ${specs.length} specs…`);

    let refsWritten = 0;
    let refsAlreadyPresent = 0;
    let parentUpdated = 0;

    for (const s of specs) {
      const slugs = extractBrainRefsLine(s.summary);
      // Read existing refs for this spec.
      const { rows: existing } = await c.query<{ brain_slug: string; phase_id: string | null }>(
        "select brain_slug, phase_id from public.spec_brain_refs where spec_id = $1 order by brain_slug",
        [s.id],
      );
      const currentSlugs = new Set(existing.filter((r) => !r.phase_id).map((r) => r.brain_slug));
      const desiredSlugs = new Set(slugs);
      const setsEqual = currentSlugs.size === desiredSlugs.size && [...currentSlugs].every((x) => desiredSlugs.has(x));

      if (slugs.length && !setsEqual) {
        refsWritten++;
        console.log(`  ${s.slug} — write ${slugs.length} spec-level brain ref(s): ${slugs.join(", ")}`);
        if (APPLY) {
          await c.query("delete from public.spec_brain_refs where spec_id = $1 and phase_id is null", [s.id]);
          for (const slug of slugs) {
            await c.query(
              "insert into public.spec_brain_refs (spec_id, phase_id, brain_slug) values ($1, null, $2) on conflict do nothing",
              [s.id, slug],
            );
          }
        }
      } else if (slugs.length) {
        refsAlreadyPresent++;
      }

      const inferred = inferParent({ parent: s.parent, milestone_id: s.milestone_id });
      if (inferred.kind && (s.parent_kind !== inferred.kind || s.parent_ref !== inferred.ref)) {
        parentUpdated++;
        console.log(`  ${s.slug} — parent → kind='${inferred.kind}' ref='${inferred.ref}'`);
        if (APPLY) {
          await c.query(
            "update public.specs set parent_kind = $1, parent_ref = $2, updated_at = now() where id = $3",
            [inferred.kind, inferred.ref, s.id],
          );
        }
      }
    }

    console.log(``);
    console.log(`Summary${APPLY ? " (APPLIED)" : " (dry-run — pass APPLY=1 to write)"}:`);
    console.log(`  brain refs written : ${refsWritten}`);
    console.log(`  brain refs unchanged: ${refsAlreadyPresent}`);
    console.log(`  parent typed        : ${parentUpdated}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
