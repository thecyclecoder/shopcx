/**
 * Ship-time backfill for creative-skeleton-wireframe-extractor-and-backfill-actually-built
 * (Phase 3). Populates `creative_skeletons.elements` (agnostic wireframe:
 * `[{zone, role, prominence}]`), `product_presentation`, and `punchiness` on the
 * ~409 skeletons ingested BEFORE Phase 2's extractor started writing the wireframe —
 * including the Onnit clone `c667b0fa` whose bottom-proof-bar render bug was the
 * observed live symptom. New ingests already carry the wireframe (Phase 2's edit
 * to `visionDeconstruct` / `visionDeconstructFrames` in
 * [[../src/lib/creative-skeleton.ts]]); this closes the legacy tail.
 *
 * Auto-ledgered by [[../src/lib/ship-time-backfill-detector.ts]]
 * `detectAndEscalateShipTimeBackfills` (regex `^scripts/_backfill-[a-z0-9][…]\.ts$`
 * — the leading `_` is what puts the file on the drain queue). Executed on the box
 * by `executeShipTimeBackfillsForSpec` in `src/lib/ship-time-backfill-executor.ts`
 * once the spec merges. A never-run backfill escalates to the CEO inbox — an
 * untracked script (no leading `_`) would silently stay dead.
 *
 * ── Two-path population ──
 * For each row with `elements IS NULL`:
 *   • PATH A — RE-VISION.  If `thumb_path` is set (our downscaled stored copy in the
 *     private `creative-shots` bucket), sign a short-lived read URL, fetch the bytes,
 *     and re-run `visionDeconstruct` — the same Phase-2 extractor the ingest path uses,
 *     so the row lands with a genuine `elements` / `product_presentation` / `punchiness`
 *     read (same shape, same whitelist, same DB-side trigger validation).
 *   • PATH B — SLOT MAPPING (fallback).  If `thumb_path` is NULL (a small subset of
 *     legacy rows never uploaded one, and the media proxy is not re-callable at scale),
 *     synthesize a minimal `elements` from the row's existing substance columns
 *     (`hook` → header/hook, `mechanism_claim` → hero/mechanism, `proof` → body/proof,
 *     `offer` → footer/offer). Tag arrays default to `[]`. This is coarse but strictly
 *     better than the NULL wireframe (which forces the M4 decision engine into the
 *     generic 'bake trust-bar + offer + proof' fallback — the very bug this spec fixes).
 *
 * ── Idempotency ──
 * Every UPDATE carries `.is("elements", null)` — a compare-and-set predicate — so a
 * re-run (or a concurrent Phase-2 ingest) can NEVER overwrite an already-populated
 * wireframe. The row selector also filters on `elements IS NULL`, so a re-run reads
 * only the still-empty tail. If the vision call returns a genuinely empty elements
 * array (`[]`), we treat it as filled (write it) — an empty array is a real answer,
 * not a null, and the compare-and-set guard keeps re-runs no-op.
 *
 * ── Dry-run by default ──
 * Pass `--apply` to write. Optional `--limit=N` to cap and `--ws=<uuid>` to scope
 * (defaults to the Superfoods workspace). The `--throttle=N` knob (ms between vision
 * calls) bounds Anthropic vision spend on the ~409-row initial run.
 *
 *   npx tsx scripts/_backfill-creative-skeletons-wireframe.ts                    # dry-run, all workspaces
 *   npx tsx scripts/_backfill-creative-skeletons-wireframe.ts --apply            # write
 *   npx tsx scripts/_backfill-creative-skeletons-wireframe.ts --apply --limit=20 # smoke test
 */
import { createAdminClient } from "./_bootstrap";
import {
  visionDeconstruct,
  signCreativeShot,
  type SkeletonElement,
} from "@/lib/creative-skeleton";

const CHUNK = 200;
const DEFAULT_WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods
const DEFAULT_THROTTLE_MS = 1200;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PATH B: synthesize a coarse wireframe from the row's existing substance columns.
 *  Used only when `thumb_path` is unavailable (re-vision impossible). Each mapped
 *  slot lands at a plausible zone + moderate prominence — strictly better than NULL
 *  for the M4 decision engine's per-element reuse verdict. */
function synthesizeElementsFromSlots(row: {
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
}): SkeletonElement[] {
  const out: SkeletonElement[] = [];
  if (row.hook) out.push({ zone: "header", role: "hook", prominence: 0.7 });
  if (row.mechanism_claim) out.push({ zone: "hero", role: "mechanism", prominence: 0.6 });
  if (row.proof) out.push({ zone: "body", role: "proof", prominence: 0.5 });
  if (row.offer) out.push({ zone: "footer", role: "offer", prominence: 0.5 });
  return out;
}

interface SkeletonRow {
  id: string;
  workspace_id: string;
  dedup_key: string;
  advertiser: string | null;
  thumb_path: string | null;
  media_type: string | null;
  hook: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const wsArg = arg("ws");
  const limit = arg("limit") ? Math.max(1, Number.parseInt(arg("limit")!, 10)) : Infinity;
  const throttleMs = arg("throttle") ? Math.max(0, Number.parseInt(arg("throttle")!, 10)) : DEFAULT_THROTTLE_MS;
  const admin = createAdminClient();

  console.log(`creative_skeletons_wireframe_backfill — ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scope: elements IS NULL${wsArg ? ` AND workspace_id=${wsArg}` : " (all workspaces)"}`);
  console.log(`  chunk: ${CHUNK}  throttle: ${throttleMs}ms  limit: ${limit === Infinity ? "∞" : limit}`);

  let totalCandidates = 0;
  let visioned = 0;      // PATH A wrote via vision
  let mapped = 0;        // PATH B wrote via slot mapping
  let alreadyFilled = 0; // compare-and-set found the row already non-null (concurrent write / re-run)
  let visionFailed = 0;  // vision call returned null (undecodable / API error) — left NULL
  let signFailed = 0;    // thumb signed-url or fetch failed — left NULL
  let cursor: string | null = null;

  // Cursor-paginate by id so a partial run resumes cleanly. Both the selector and
  // every UPDATE filter on `elements IS NULL` (the `.is("elements", null)` / SQL
  // `is null` compare-and-set), so a re-run touches only the still-empty tail
  // even if the last cursor was lost.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (totalCandidates >= limit) break;
    const remaining = limit === Infinity ? CHUNK : Math.min(CHUNK, limit - totalCandidates);

    let query = admin
      .from("creative_skeletons")
      .select("id, workspace_id, dedup_key, advertiser, thumb_path, media_type, hook, mechanism_claim, proof, offer")
      .is("elements", null)
      .order("id", { ascending: true })
      .limit(remaining);
    if (wsArg) query = query.eq("workspace_id", wsArg);
    if (cursor) query = query.gt("id", cursor);

    const { data, error } = await query;
    if (error) {
      console.error("read_failed", error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as SkeletonRow[];
    if (rows.length === 0) break;
    totalCandidates += rows.length;

    for (const row of rows) {
      let elements: SkeletonElement[] | null = null;
      let productPresentation: string[] = [];
      let punchiness: string[] = [];
      let source: "vision" | "slots" | "skip" = "skip";

      // PATH A — RE-VISION when a stored thumb exists.
      if (row.thumb_path) {
        try {
          const signed = await signCreativeShot(row.thumb_path);
          if (!signed) {
            signFailed++;
          } else {
            const res = await fetch(signed);
            if (!res.ok) {
              signFailed++;
            } else {
              const buf = Buffer.from(await res.arrayBuffer());
              const skeleton = await visionDeconstruct(row.workspace_id, buf, "image/jpeg");
              if (!skeleton || skeleton.elements === null) {
                visionFailed++;
              } else {
                elements = skeleton.elements;
                productPresentation = skeleton.product_presentation;
                punchiness = skeleton.punchiness;
                source = "vision";
              }
            }
          }
        } catch (e) {
          visionFailed++;
          console.warn(`  ✗ ${row.dedup_key}: vision threw ${(e as Error).message}`);
        }
        if (throttleMs > 0) await sleep(throttleMs);
      }

      // PATH B — SLOT MAPPING fallback (thumb missing, sign/fetch failed, or vision
      // returned nothing usable). Only synthesize when at least ONE slot is set; a
      // row with all-null slots stays NULL (nothing to derive from).
      if (source === "skip" && (row.hook || row.mechanism_claim || row.proof || row.offer)) {
        elements = synthesizeElementsFromSlots(row);
        source = "slots";
      }

      if (source === "skip" || elements === null) {
        // Nothing to write for this row — leave elements NULL. A future run with a
        // freshly-uploaded thumb_path will retry via PATH A.
        continue;
      }

      if (!apply) {
        if (source === "vision") visioned++;
        else mapped++;
        continue;
      }

      // Compare-and-set: only flip a row whose elements is STILL null so a concurrent
      // Phase-2 ingest (or a prior re-run) can never overwrite a genuine extraction.
      // `.select("id")` asserts the row transitioned; a zero-row response means the
      // row was filled between our read and write (counted as alreadyFilled, not
      // failed). Note: product_presentation / punchiness are `text[] NOT NULL DEFAULT '{}'`
      // so we always write them, but the elements-null guard is the single source of
      // truth for idempotency — an already-filled row's tag arrays are already set
      // and the CAS bails before we clobber them.
      const { data: updated, error: updErr } = await admin
        .from("creative_skeletons")
        .update({
          elements,
          product_presentation: productPresentation,
          punchiness,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .is("elements", null)
        .select("id");
      if (updErr) {
        console.error(`update_failed id=${row.id}`, updErr.message);
        process.exit(1);
      }
      if ((updated ?? []).length === 0) {
        alreadyFilled++;
      } else {
        if (source === "vision") visioned++;
        else mapped++;
      }
    }

    cursor = rows[rows.length - 1].id;
    console.log(
      `  cursor=${cursor.slice(0, 8)}  candidates=${totalCandidates}  visioned=${visioned}  mapped=${mapped}  alreadyFilled=${alreadyFilled}  signFailed=${signFailed}  visionFailed=${visionFailed}`,
    );
    if (rows.length < remaining) break;
  }

  console.log("");
  console.log(`  total candidates:  ${totalCandidates}`);
  console.log(`  visioned (PATH A): ${visioned}`);
  console.log(`  mapped   (PATH B): ${mapped}`);
  console.log(`  already filled:    ${alreadyFilled}  (concurrent write / re-run — CAS bailed as designed)`);
  console.log(`  sign/fetch failed: ${signFailed}  (left NULL — will retry next run)`);
  console.log(`  vision failed:     ${visionFailed}  (left NULL — will retry next run)`);
  if (!apply) {
    console.log("\n(dry-run) — rerun with --apply to populate elements/product_presentation/punchiness.");
  }
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
