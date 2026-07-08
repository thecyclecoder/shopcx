/**
 * reconcile-judy-loyalty-burn — one-off verification that Judy's 1,500-point
 * spend from ticket 0a9e4d7f is BACKED by the coupon LOYALTY-15-HC6UFJ that
 * was eventually applied to her order-now via a manual remedy. Confirms
 * "points spent == coupon applied, no orphan" per the atomic redeem→apply
 * contract Phase 2 verification bullet.
 *
 * Not `_`-prefixed — an executed operational artifact stays in the repo for
 * audit per `script-conventions` (scripts/_* is .gitignore'd). The atomic
 * guardrail on the code path (Phase 1) prevents a recurrence going forward;
 * this script is the historical closeout for the SINGLE customer whose
 * points were burned before the guardrail landed.
 *
 * Read-only by default. `--apply` is a NO-OP for this script: any drift the
 * reconciler surfaces is a one-off judgment call (a manual `deductPoints` /
 * `earnPoints` adjustment against her member row, whose exact amount depends
 * on what the drift IS). The script prints the recommended adjustment; the
 * operator applies it via `scripts/customer-remedy` or the dashboard.
 *
 *   npx tsx scripts/reconcile-judy-loyalty-burn.ts
 */
import { createAdminClient } from "./_bootstrap";

const JUDY_MEMBER_ID = "28d83617-26f8-4d02-88a7-97f69c0a8d99";
const REDEMPTION_CODE = "LOYALTY-15-HC6UFJ";
const REDEMPTION_TICKET = "0a9e4d7f";
const EXPECTED_POINTS_SPENT = 1500;

interface TxRow {
  id: string;
  member_id: string;
  points_change: number;
  type: string;
  description: string | null;
  order_id: string | null;
  shopify_discount_id: string | null;
  created_at: string;
}

interface RedemptionRow {
  id: string;
  workspace_id: string;
  member_id: string;
  reward_tier: string;
  discount_code: string;
  points_spent: number;
  discount_value: number;
  status: string;
  shopify_discount_id: string | null;
  used_at: string | null;
  created_at: string;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

async function main() {
  const admin = createAdminClient();

  console.log(`── reconcile-judy-loyalty-burn ─────────────────────────`);
  console.log(`Member: ${JUDY_MEMBER_ID}`);
  console.log(`Code:   ${REDEMPTION_CODE}  (ticket ${REDEMPTION_TICKET})`);
  console.log();

  // 1. Member row — balance snapshot.
  const { data: member, error: memberErr } = await admin
    .from("loyalty_members")
    .select("id, workspace_id, customer_id, shopify_customer_id, points_balance, points_earned, points_spent, email")
    .eq("id", JUDY_MEMBER_ID)
    .maybeSingle();
  if (memberErr) {
    console.error(`✗ loyalty_members read failed: ${memberErr.message}`);
    process.exit(1);
  }
  if (!member) {
    console.error(`✗ member ${JUDY_MEMBER_ID} not found — nothing to reconcile.`);
    process.exit(1);
  }
  console.log(`Member row:`);
  console.log(`  workspace_id  = ${member.workspace_id}`);
  console.log(`  email         = ${member.email ?? "(null)"}`);
  console.log(`  points_earned = ${member.points_earned}`);
  console.log(`  points_spent  = ${member.points_spent}`);
  console.log(`  points_balance= ${member.points_balance}`);
  console.log();

  // 2. Redemption row for LOYALTY-15-HC6UFJ.
  const { data: redemption, error: redErr } = await admin
    .from("loyalty_redemptions")
    .select("id, workspace_id, member_id, reward_tier, discount_code, points_spent, discount_value, status, shopify_discount_id, used_at, created_at")
    .eq("workspace_id", member.workspace_id)
    .eq("discount_code", REDEMPTION_CODE)
    .maybeSingle();
  if (redErr) {
    console.error(`✗ loyalty_redemptions read failed: ${redErr.message}`);
    process.exit(1);
  }
  if (!redemption) {
    console.error(`✗ redemption ${REDEMPTION_CODE} not found for member's workspace — cannot verify landing.`);
    process.exit(1);
  }
  const r = redemption as RedemptionRow;
  console.log(`Redemption row:`);
  console.log(`  reward_tier   = ${r.reward_tier}`);
  console.log(`  points_spent  = ${r.points_spent}`);
  console.log(`  discount_value= $${r.discount_value}`);
  console.log(`  status        = ${r.status}`);
  console.log(`  used_at       = ${r.used_at ?? "(null)"}`);
  console.log(`  shopify_disc  = ${r.shopify_discount_id ?? "(null)"}`);
  console.log();

  // 3. All loyalty_transactions for this member — sum vs balance.
  const { data: txs, error: txErr } = await admin
    .from("loyalty_transactions")
    .select("id, member_id, points_change, type, description, order_id, shopify_discount_id, created_at")
    .eq("member_id", JUDY_MEMBER_ID)
    .order("created_at", { ascending: true });
  if (txErr) {
    console.error(`✗ loyalty_transactions read failed: ${txErr.message}`);
    process.exit(1);
  }
  const rows = (txs ?? []) as TxRow[];
  const earned = rows.filter(t => t.points_change > 0).reduce((s, t) => s + t.points_change, 0);
  const spent = rows.filter(t => t.points_change < 0).reduce((s, t) => s + Math.abs(t.points_change), 0);
  const netFromTxs = earned - spent;
  console.log(`Transaction ledger (${rows.length} rows):`);
  console.log(`  sum(+ changes) = ${earned}`);
  console.log(`  sum(- changes) = ${spent}`);
  console.log(`  net (should == balance) = ${netFromTxs}`);
  console.log();

  // 4. Isolate the redemption's spending row + any rollback/adjustment
  //    referencing the code — the "no double-charge / no orphan" check.
  const codeTxs = rows.filter(t =>
    t.shopify_discount_id === r.shopify_discount_id ||
    (t.description ?? "").includes(REDEMPTION_CODE) ||
    (t.description ?? "").toLowerCase().includes("hc6ufj"),
  );
  console.log(`Transactions linked to ${REDEMPTION_CODE} (${codeTxs.length}):`);
  for (const t of codeTxs) {
    console.log(`  ${t.created_at}  ${pad(t.type, 12)} ${String(t.points_change).padStart(6)}  ${t.description ?? ""}`);
  }
  console.log();

  // ── Verification checks ────────────────────────────────────────────

  const problems: string[] = [];
  const notes: string[] = [];

  // (a) The redemption row records the expected 1,500-pt spend.
  if (r.points_spent !== EXPECTED_POINTS_SPENT) {
    problems.push(`redemption.points_spent = ${r.points_spent}, expected ${EXPECTED_POINTS_SPENT}`);
  }

  // (b) Ledger arithmetic reconciles with the stored balance.
  if (netFromTxs !== member.points_balance) {
    problems.push(`ledger net (${netFromTxs}) != member.points_balance (${member.points_balance}) — drift of ${netFromTxs - member.points_balance}`);
  }

  // (c) No double-spend for this code. Count -1500 (or matching)
  //     spending-type entries against the code.
  const codeSpends = codeTxs.filter(t => t.points_change < 0);
  const codeCredits = codeTxs.filter(t => t.points_change > 0);
  if (codeSpends.length === 0) {
    problems.push(`no spending transaction found for ${REDEMPTION_CODE} — the redemption's -${EXPECTED_POINTS_SPENT} debit is missing.`);
  } else if (codeSpends.length > 1) {
    problems.push(`${codeSpends.length} spending transactions for ${REDEMPTION_CODE} — expected exactly 1 (possible double-charge).`);
  }

  // (d) Rollback should NOT have fired for Judy (the manual remedy
  //     landed the coupon on her order-now, so the redeem is BACKED).
  //     If a rollback credit exists AND the redemption is 'used'/'applied',
  //     we have a double-benefit (points refunded AND coupon applied).
  const rollbackCredits = codeCredits.filter(t =>
    (t.description ?? "").toLowerCase().includes("rollback") ||
    t.type === "adjustment",
  );
  const couponLanded = r.status === "used" || r.status === "applied";
  if (rollbackCredits.length > 0 && couponLanded) {
    problems.push(
      `${rollbackCredits.length} rollback/adjustment credit(s) found for ${REDEMPTION_CODE} but redemption.status=${r.status} — customer got points AND coupon (double-benefit).`,
    );
  }
  if (rollbackCredits.length > 0 && !couponLanded) {
    notes.push(`rollback credit(s) present; redemption.status=${r.status}. Points restored, coupon not landed — expected outcome for a rolled-back redeem.`);
  }
  if (rollbackCredits.length === 0 && couponLanded) {
    notes.push(`clean landing: 1 debit, no rollback credit, redemption.status=${r.status}. Points spent BACK the applied coupon — no orphan.`);
  }
  if (rollbackCredits.length === 0 && !couponLanded && r.status === "active") {
    notes.push(`redemption still 'active' — coupon has not consumed yet. Points spent, code awaiting use. Not orphan (yet).`);
  }

  // ── Verdict ───────────────────────────────────────────────────────

  console.log(`── verdict ──`);
  for (const n of notes) console.log(`  · ${n}`);
  if (problems.length === 0) {
    console.log(`✓ RECONCILED — Judy's ${EXPECTED_POINTS_SPENT}-pt spend is backed by ${REDEMPTION_CODE}; no orphan, no double-charge.`);
    process.exit(0);
  }
  console.log(`✗ DRIFT (${problems.length}):`);
  for (const p of problems) console.log(`  · ${p}`);
  console.log();
  console.log(`Recommended follow-up: review the flagged rows; if a manual`);
  console.log(`adjustment is warranted, use scripts/customer-remedy or the`);
  console.log(`loyalty dashboard to write the correction — this reconcile`);
  console.log(`script is READ-ONLY and does not mutate balances.`);
  process.exit(1);
}

main().catch(err => {
  console.error(`✗ reconcile crashed:`, err);
  process.exit(1);
});
