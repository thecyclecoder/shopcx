/**
 * Backfill orders.financial_status to match the refund ledger.
 *
 * Phase 2 of docs/brain/specs/a-refunded-order-must-say-it-was-refunded.md.
 *
 * Phase 1 fixed the write path forward — `refundOrder` now stamps
 * `orders.financial_status` after every succeeded refund it dispatches.
 * That leaves the historical wall in place: measured 2026-09-18, 218
 * orders carry a succeeded refund; 15 internal orders and 33 store
 * orders under-report on the column. Fifteen of them read `PAID` while
 * their customer was refunded in full — a support surface reading the
 * order row alone would say the customer paid, when they were made
 * whole.
 *
 * For every order with a positive succeeded/settled refund sum, compare
 * that sum against `total_cents` and write the derived state ONLY when
 * it differs from what the column already carries:
 *   - refundedTotalCents >= total_cents  ⇒ 'refunded'
 *   - refundedTotalCents > 0             ⇒ 'partially_refunded'
 *
 * Compare case-insensitively (the column carries both `PAID`/`paid` and
 * `REFUNDED`/`refunded` and `PARTIALLY_REFUNDED`/`partially_refunded` in
 * prod — see docs/brain/tables/orders.md § financial_status). A stored
 * `REFUNDED` and a derived `refunded` are the same value, and this run
 * must be a no-op on such a row. Write lowercase for consistency with
 * `refundOrder`'s Phase-1 write.
 *
 * NEVER write a state that would claim MORE refunded than the ledger
 * shows. The compare-and-set on the write is scoped to `(id, workspace_id)`
 * AND asserts the pre-image state we read — so a concurrent live refund
 * that advances the state between our read and our write cannot regress
 * it here. Weight: `refunded` > `partially_refunded` > everything else;
 * the write only fires when the derived weight is STRICTLY GREATER than
 * the current stored weight. That guard also handles the correction of
 * hand-fixed orders: a row already stamped `partially_refunded` (or
 * `refunded`) at the correct level compares equal or greater and is
 * skipped — the idempotency proof this Phase 2 requires.
 *
 * Dry-run by default. Pass --apply to write.
 *   npx tsx scripts/_backfill-order-financial-status.ts            # dry-run
 *   npx tsx scripts/_backfill-order-financial-status.ts --apply    # write
 *
 * Idempotency: re-running is a no-op — every row's derived state equals
 * its stored state after the first pass, and the hand-fixed orders are
 * observed and skipped rather than overwritten (Phase 2 spec §
 * "Re-running must be a no-op").
 */
import { pgClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const UPDATE_BATCH = 500;

type CandidateRow = {
  order_id: string;
  order_number: string | null;
  workspace_id: string;
  shopify_order_id: string | null;
  total_cents: number;
  financial_status: string | null;
  refunded_cents: number;
};

type ToWriteRow = {
  order_id: string;
  order_number: string | null;
  workspace_id: string;
  engine: "internal" | "shopify";
  current: string;                 // as stored (may be upper-case)
  next: "refunded" | "partially_refunded";
  refunded_cents: number;
  total_cents: number;
};

/** Higher weight = further along the refund ladder. Case-insensitive keying. */
function statusWeight(raw: string | null | undefined): number {
  const s = String(raw ?? "").toLowerCase();
  if (s === "refunded") return 2;
  if (s === "partially_refunded") return 1;
  return 0;
}

/**
 * Pure predicate: given the stored value + ledger + total, decide the
 * write. Returns `null` on no-op (already correct, or ledger sum would
 * regress a stronger stored state, or nothing to backfill).
 *
 * Guardrails baked in:
 *   - refunded_cents <= total_cents is enforced by the caller SQL; here
 *     we treat the ledger sum as authoritative and never propose a state
 *     that claims MORE than it shows.
 *   - stored `refunded` is never regressed (currentWeight=2 => no write).
 *   - stored `partially_refunded` + derived `partially_refunded` => no
 *     write (equal weight, idempotent).
 *   - stored `partially_refunded` + derived `refunded` => write (the
 *     backfill's job when two partials cleared the total on a row Phase-1
 *     hadn't yet visited).
 */
export function decideFinancialStatusRewrite(input: {
  storedStatus: string | null;
  totalCents: number;
  refundedCents: number;
}): "refunded" | "partially_refunded" | null {
  const total = Number(input.totalCents) || 0;
  const refunded = Number(input.refundedCents) || 0;
  if (refunded <= 0) return null;
  let next: "refunded" | "partially_refunded";
  if (total > 0) {
    next = refunded >= total ? "refunded" : "partially_refunded";
  } else {
    next = "refunded";
  }
  const currentWeight = statusWeight(input.storedStatus);
  const nextWeight = next === "refunded" ? 2 : 1;
  if (nextWeight > currentWeight) return next;
  return null;
}

async function main(): Promise<void> {
  const c = pgClient();
  await c.connect();
  const t0 = Date.now();
  try {
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(`Workspace: ${WS}\n`);

    // Every order that carries a succeeded/settled refund. Drive off the
    // ledger, not off financial_status — a row whose column is wrong is
    // exactly the row we're here to correct, so we cannot filter by the
    // column. The predicate below is the one that decides the write.
    const { rows: raw } = await c.query<CandidateRow>(
      `WITH mirror AS (
         SELECT order_id, COALESCE(SUM(amount_cents), 0)::int AS refunded_cents
           FROM public.order_refunds
          WHERE workspace_id = $1::uuid
            AND status IN ('succeeded', 'settled')
          GROUP BY order_id
       )
       SELECT
         o.id             AS order_id,
         o.order_number,
         o.workspace_id,
         o.shopify_order_id,
         COALESCE(o.total_cents, 0)::int AS total_cents,
         o.financial_status,
         m.refunded_cents
       FROM public.orders o
       JOIN mirror m ON m.order_id = o.id
       WHERE o.workspace_id = $1::uuid
         AND m.refunded_cents > 0
       ORDER BY o.created_at ASC`,
      [WS],
    );

    console.log(`Orders carrying a succeeded/settled refund: ${raw.length}`);

    const toWrite: ToWriteRow[] = [];
    const engineTotals: Record<"internal" | "shopify", { stale: number; ok: number }> = {
      internal: { stale: 0, ok: 0 },
      shopify:  { stale: 0, ok: 0 },
    };
    const skipReasons: Record<string, number> = {};

    for (const r of raw) {
      const engine: "internal" | "shopify" = r.shopify_order_id ? "shopify" : "internal";
      const next = decideFinancialStatusRewrite({
        storedStatus: r.financial_status,
        totalCents: r.total_cents,
        refundedCents: r.refunded_cents,
      });
      if (!next) {
        // Report the reason we skipped so a re-run's decision breakdown
        // is legible: already at target, already stronger, or nothing to
        // backfill.
        const stored = String(r.financial_status ?? "").toLowerCase();
        const derived =
          r.refunded_cents >= r.total_cents && r.total_cents > 0 ? "refunded" : "partially_refunded";
        let reason: string;
        if (r.refunded_cents <= 0) reason = "no_refund";
        else if (stored === "refunded") reason = "already_refunded";
        else if (stored === derived) reason = "already_correct";
        else if (statusWeight(stored) >= statusWeight(derived)) reason = "stored_stronger";
        else reason = "already_correct";
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        engineTotals[engine].ok++;
        continue;
      }
      engineTotals[engine].stale++;
      toWrite.push({
        order_id: r.order_id,
        order_number: r.order_number,
        workspace_id: r.workspace_id,
        engine,
        current: String(r.financial_status ?? ""),
        next,
        refunded_cents: r.refunded_cents,
        total_cents: r.total_cents,
      });
    }

    console.log(`\nBy engine:`);
    for (const [engine, b] of Object.entries(engineTotals)) {
      console.log(`  ${engine.padEnd(10)} stale=${b.stale} ok=${b.ok}`);
    }
    console.log(`\nDecision breakdown (no-op reasons):`);
    for (const [reason, count] of Object.entries(skipReasons)) {
      console.log(`  skip:${reason.padEnd(20, " ")} ${count}`);
    }
    console.log(`  write:${"".padEnd(19, " ")} ${toWrite.length}`);

    if (toWrite.length > 0) {
      const byTransition: Record<string, number> = {};
      for (const r of toWrite) {
        const key = `${(r.current || "(null)").toLowerCase()} → ${r.next}`;
        byTransition[key] = (byTransition[key] ?? 0) + 1;
      }
      console.log(`\nTransitions:`);
      for (const [t, count] of Object.entries(byTransition)) {
        console.log(`  ${t.padEnd(38)} ${count}`);
      }
      console.log(`\nFirst 10 to write:`);
      for (const r of toWrite.slice(0, 10)) {
        const dollars = (r.refunded_cents / 100).toFixed(2);
        const total = (r.total_cents / 100).toFixed(2);
        console.log(
          `  order=${r.order_number ?? r.order_id} engine=${r.engine.padEnd(8)} ${(r.current || "(null)").toLowerCase().padEnd(20)} → ${r.next.padEnd(20)} ledger=$${dollars}/$${total}`,
        );
      }
    }

    if (!APPLY) {
      console.log(`\nDry-run only. Re-run with --apply to update ${toWrite.length} row(s).`);
      return;
    }

    if (toWrite.length === 0) {
      console.log(`\n✓ Nothing to write — every order's financial_status already reflects its refund ledger.`);
      return;
    }

    // Compare-and-set on the write. The UPDATE:
    //   1. re-reads the current financial_status inside the same statement
    //      and only fires when the stored casing-normalized value is STILL
    //      lower than what we're writing (a concurrent live refund that
    //      advanced the state between our read and this write cannot be
    //      regressed here).
    //   2. re-reads the ledger sum inside the same statement and refuses
    //      to write `refunded` when the summed succeeded/settled refunds
    //      no longer reach `total_cents` (never claim MORE refunded than
    //      the ledger shows — the Phase 2 spec invariant).
    //   3. is `.eq(id, workspace_id)` so it cannot reach across tenants.
    let updated = 0;
    let raced = 0;
    for (let i = 0; i < toWrite.length; i += UPDATE_BATCH) {
      const chunk = toWrite.slice(i, i + UPDATE_BATCH);
      for (const r of chunk) {
        const desiredWeight = r.next === "refunded" ? 2 : 1;
        const res = await c.query(
          `UPDATE public.orders o
              SET financial_status = $3::text
            WHERE o.id           = $1::uuid
              AND o.workspace_id = $2::uuid
              AND (
                CASE LOWER(COALESCE(o.financial_status, ''))
                  WHEN 'refunded'           THEN 2
                  WHEN 'partially_refunded' THEN 1
                  ELSE 0
                END
              ) < $4::int
              AND (
                $3::text <> 'refunded'
                OR (
                  SELECT COALESCE(SUM(amount_cents), 0)
                    FROM public.order_refunds
                   WHERE workspace_id = $2::uuid
                     AND order_id     = $1::uuid
                     AND status IN ('succeeded', 'settled')
                ) >= COALESCE(o.total_cents, 0)
              )`,
          [r.order_id, r.workspace_id, r.next, desiredWeight],
        );
        const rowCount = res.rowCount ?? 0;
        if (rowCount === 1) updated++;
        else raced++;
      }
      process.stdout.write(`  updated ${updated}/${toWrite.length} (raced/skipped: ${raced})\r`);
    }
    console.log(`\n✓ updated ${updated} row(s) (${raced} skipped by guard/race).`);

    // Post-apply verification — count remaining contradictions between
    // ledger and column. Success = zero.
    const { rows: verifyRow } = await c.query<{ remaining_stale: number }>(
      `WITH mirror AS (
         SELECT order_id, COALESCE(SUM(amount_cents), 0)::int AS refunded_cents
           FROM public.order_refunds
          WHERE workspace_id = $1::uuid
            AND status IN ('succeeded', 'settled')
          GROUP BY order_id
       )
       SELECT COUNT(*)::int AS remaining_stale
         FROM public.orders o
         JOIN mirror m ON m.order_id = o.id
        WHERE o.workspace_id = $1::uuid
          AND m.refunded_cents > 0
          AND (
            (
              m.refunded_cents >= COALESCE(o.total_cents, 0)
              AND COALESCE(o.total_cents, 0) > 0
              AND LOWER(COALESCE(o.financial_status, '')) NOT IN ('refunded')
            )
            OR
            (
              m.refunded_cents < COALESCE(o.total_cents, 0)
              AND m.refunded_cents > 0
              AND LOWER(COALESCE(o.financial_status, '')) NOT IN ('refunded', 'partially_refunded')
            )
          )`,
      [WS],
    );
    const remaining = verifyRow[0]?.remaining_stale ?? -1;
    console.log(`\nPost-apply verification: ${remaining} order(s) still contradict the ledger.`);
    if (remaining !== 0) {
      console.log(
        `  (Expected 0. A non-zero count is a real drift signal — investigate before re-running.)`,
      );
    }
  } finally {
    await c.end();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nDone in ${dt}s.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
