/**
 * Phase 1 reproduction harness for the loyalty coupon-apply double-spend
 * (spec: loyalty-coupon-apply-self-heal-must-not-double-deduct-points).
 *
 * Susan D. (member aa8fe19e, ticket d19c2192) was charged 1,500 pts TWICE
 * within 12s on 2026-07-09 for the ONE $15 coupon actually applied to her
 * Jul 19 renewal — same pattern visible Jun 11 (×3) and Jun 25 (×2).
 *
 * ── End-to-end trace of the buggy path ────────────────────────────────
 *
 * There are TWO apply surfaces:
 *
 *   PORTAL (customer clicks "Apply reward"):
 *     src/lib/portal/handlers/loyalty-apply-subscription.ts
 *       :138 → spendPoints(...) — first spend when redeeming inline (redeem+apply)
 *       :194 → applyDiscountWithReplace(apiKey, contractId, code) — initial apply
 *       :197 → self-heal branch: Appstle rejects with status===400
 *       :210-273 → delete stale Shopify code + generate new code + retry apply
 *       (NO extra spendPoints in this self-heal branch — the double-spend
 *        arises when the CUSTOMER retries the whole apply from the UI: each
 *        click through the redeem-then-apply arm at :72-155 re-runs
 *        spendPoints at :138.)
 *
 *   ACTION-EXECUTOR (Sonnet / operator "apply_loyalty_coupon"):
 *     src/lib/action-executor.ts
 *       :1266  apply_loyalty_coupon handler entry
 *       :1277 → subscriptionApplyCoupon(workspaceId, contract_id, code)  (initial "re-apply")
 *       :1280-1364  regen branch fired when initial apply fails ("verify fail")
 *         :1287-1290 → lookup orig loyalty_redemption by discount_code (NO status filter)
 *         :1309-1324 → Shopify discountCodeBasicCreate — MINT new code
 *         :1332-1334 → REFUND old points directly to loyalty_members.points_balance
 *                      (a bare balance update — NOT a loyalty_transactions row)
 *         :1338    → mark orig redemption status='expired'
 *         :1344    → spendPoints(refreshedMember, tier.points_cost,
 *                                 "Redeemed ${tier.label} (regenerated)", discountId)
 *                    ← THE second (and, on N-th retry, the N-th) -1500 row.
 *         :1348-1354 → insert new loyalty_redemptions row (discount_code=newCode, status='active')
 *         :1357    → subscriptionApplyCoupon(workspaceId, contract_id, newCode)
 *
 *   spendPoints itself:
 *     src/lib/loyalty.ts:351-387 — inserts a -points_change row on
 *     loyalty_transactions and updates loyalty_members. NO idempotency key
 *     on either write.
 *
 * ── Why a retry re-enters spendPoints (regenerate vs re-apply) ────────
 *
 * The observed signature on Susan's ledger is
 *   description = "Redeemed $15 Off (regenerated)"
 * so the double-deducts come from the ACTION-EXECUTOR regen branch, NOT
 * the portal self-heal branch (which has no "(regenerated)" description).
 *
 * The path that re-enters spendPoints is *REGENERATE*, not *re-apply*:
 *
 *   1. First call: outer caller invokes apply_loyalty_coupon(code=OLD).
 *      subscriptionApplyCoupon(OLD) fails → regen branch runs to completion:
 *      redemption OLD flipped to 'expired', redemption NEW1 (active) inserted,
 *      spendPoints (regenerated) fires once, apply(NEW1) succeeds.
 *
 *   2. The outer verify wrapper (verify-in-db and/or the caller's own
 *      retry) does not know the code was regenerated — it retries
 *      apply_loyalty_coupon with the ORIGINAL code (OLD).
 *      subscriptionApplyCoupon(OLD) fails again (OLD is deleted) → regen
 *      branch fires AGAIN. Because the SELECT at action-executor.ts:1287
 *      filters only on discount_code with NO status filter, it still finds
 *      the 'expired' OLD redemption, refunds `orig.points_spent` (1,500)
 *      directly to the balance, mints NEW2, and calls spendPoints
 *      (regenerated) → the SECOND -1500 row within seconds.
 *
 *   3. Any further retry loops the same regen path (Jun 11 ×3 = three
 *      regens, Jun 25 ×2, Jul 09 ×2), each producing a fresh -1500 row.
 *
 * The idempotency key for the Phase 2 fix is therefore the ORIGINAL
 * discount code (p.code) — if a regen has already run for THIS
 * (workspace_id, member_id, original code), do not enter regen again;
 * either return the state of the completed regen (currently-active
 * redemption + retry the apply against its code) or short-circuit.
 * "Coupon-apply request id" would work too but there is no such id
 * threaded through the retry today — the code IS the durable key.
 *
 * ── How to run ────────────────────────────────────────────────────────
 *
 * READ-ONLY audit mode (always safe — reproduces the FINGERPRINT by
 * querying real ledger rows; needs SUPABASE_SERVICE_ROLE_KEY):
 *     npx tsx scripts/_repro-loyalty-double-spend.ts --audit
 *
 * DRY-RUN simulator mode (default — pure, no DB, exercises the regen
 * mechanism against an in-memory fake admin and prints the
 * loyalty_transactions rows the current code would insert):
 *     npx tsx scripts/_repro-loyalty-double-spend.ts
 *
 * A test that asserts the same failing state (unit gate) lives at:
 *     src/lib/action-executor.apply-loyalty-coupon-double-spend.test.ts
 */
import { loadEnv, createAdminClient } from "./_bootstrap";

type TxRow = {
  workspace_id: string;
  member_id: string;
  points_change: number;
  type: string;
  description: string;
  shopify_discount_id: string | null;
};

type MemberRow = {
  id: string;
  workspace_id: string;
  points_balance: number;
  points_spent: number;
};

type RedemptionRow = {
  id: string;
  workspace_id: string;
  member_id: string;
  discount_code: string;
  discount_value: number;
  points_spent: number;
  status: string;
};

/**
 * Pure re-implementation of the action-executor.ts apply_loyalty_coupon
 * REGEN branch (:1280-1354) — only the mutating steps that touch the
 * points ledger. Kept verbatim on structure so a regression in either
 * copy is visible in the other.
 *
 * The one behavior we're proving: when this runs TWICE for the same
 * original code, TWO "(regenerated)" -1500 rows land.
 */
function runRegenBranchOnce(args: {
  workspaceId: string;
  code: string;          // original code passed in by the caller
  members: MemberRow[];
  redemptions: RedemptionRow[];
  transactions: TxRow[];
  mintedCodeSuffix: string; // makes newCode unique between iterations
}): { newCode: string } {
  const { workspaceId, code, members, redemptions, transactions, mintedCodeSuffix } = args;

  // action-executor.ts:1287 — lookup orig redemption BY DISCOUNT CODE with
  // NO status filter. This is the durable-key hole: after the first regen,
  // the orig row is `expired` but still matches.
  const orig = redemptions.find(
    (r) => r.discount_code === code && r.workspace_id === workspaceId,
  );
  if (!orig) throw new Error(`orig not found for ${code}`);

  const member = members.find((m) => m.id === orig.member_id);
  if (!member) throw new Error("member not found");

  const newCode = `LOYALTY-${orig.discount_value}-${mintedCodeSuffix}`;
  const newDiscountId = `gid://shopify/DiscountCodeNode/${mintedCodeSuffix}`;

  // action-executor.ts:1332-1334 — direct balance refund (NOT a tx row).
  member.points_balance = member.points_balance + orig.points_spent;

  // action-executor.ts:1338 — mark orig expired.
  orig.status = "expired";

  // action-executor.ts:1344 — the spendPoints call. This is where the
  // repeat -1500 row appears on every regen loop.
  transactions.push({
    workspace_id: workspaceId,
    member_id: member.id,
    points_change: -orig.points_spent,
    type: "spending",
    description: `Redeemed $${orig.discount_value} Off (regenerated)`,
    shopify_discount_id: newDiscountId,
  });
  member.points_balance = Math.max(0, member.points_balance - orig.points_spent);
  member.points_spent = member.points_spent + orig.points_spent;

  // action-executor.ts:1348-1354 — new redemption row.
  redemptions.push({
    id: `red-${mintedCodeSuffix}`,
    workspace_id: workspaceId,
    member_id: member.id,
    discount_code: newCode,
    discount_value: orig.discount_value,
    points_spent: orig.points_spent,
    status: "active",
  });

  return { newCode };
}

async function runDrySimulator(): Promise<void> {
  console.log("\n[dry-sim] Susan-style seed state:");
  const member: MemberRow = {
    id: "mem-susan",
    workspace_id: "ws-superfoods",
    points_balance: 500,   // remaining after first spend from 2,000
    points_spent: 1500,
  };
  const ORIG_CODE = "LOYALTY-15-OLDXYZ";
  const redemptions: RedemptionRow[] = [{
    id: "red-orig",
    workspace_id: "ws-superfoods",
    member_id: "mem-susan",
    discount_code: ORIG_CODE,
    discount_value: 15,
    points_spent: 1500,
    status: "active",
  }];
  const transactions: TxRow[] = [];

  console.log(`  member points_balance=${member.points_balance}, points_spent=${member.points_spent}`);
  console.log(`  redemption ${ORIG_CODE} status=active`);

  // Caller invokes apply_loyalty_coupon twice with the ORIGINAL code
  // (verify wrapper / operator retry). Each call fails the initial
  // subscriptionApplyCoupon and enters the regen branch.
  console.log("\n[dry-sim] Regen attempt #1 (initial verify-fail → regen):");
  const r1 = runRegenBranchOnce({
    workspaceId: "ws-superfoods",
    code: ORIG_CODE,
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "AAA111",
  });
  console.log(`  minted ${r1.newCode}`);
  console.log(`  member points_balance=${member.points_balance}, points_spent=${member.points_spent}`);
  console.log(`  loyalty_transactions rows so far: ${transactions.length}`);

  console.log("\n[dry-sim] Regen attempt #2 (retry with ORIGINAL code — the bug):");
  const r2 = runRegenBranchOnce({
    workspaceId: "ws-superfoods",
    code: ORIG_CODE,
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "BBB222",
  });
  console.log(`  minted ${r2.newCode}`);
  console.log(`  member points_balance=${member.points_balance}, points_spent=${member.points_spent}`);
  console.log(`  loyalty_transactions rows so far: ${transactions.length}`);

  console.log("\n[dry-sim] Ledger for member mem-susan:");
  for (const tx of transactions) {
    console.log(`  ${tx.points_change}  ${tx.type}  "${tx.description}"  ${tx.shopify_discount_id}`);
  }

  const spendCount = transactions.filter((t) => t.points_change === -1500 && t.type === "spending").length;
  console.log(`\n[dry-sim] Total -1500 spending rows for ONE applied coupon: ${spendCount}`);
  if (spendCount !== 2) {
    throw new Error(`Expected 2 double-deducts but got ${spendCount}`);
  }
  console.log("[dry-sim] ✔ Reproduced: TWO -1500 spending rows for one applied coupon (bug present, pre-Phase-2).");
}

async function runReadOnlyAudit(): Promise<void> {
  loadEnv();
  const admin = createAdminClient();

  console.log("\n[audit] Scanning loyalty_transactions for the double-'(regenerated)' fingerprint…");

  // Grab every spending row whose description carries the "(regenerated)"
  // signature. If Phase 1 is right, they cluster in twos/threes per
  // member within a ~60s window — the durable fingerprint of the regen
  // branch firing repeatedly for one apply attempt.
  const { data, error } = await admin
    .from("loyalty_transactions")
    .select("id, workspace_id, member_id, points_change, description, created_at, shopify_discount_id")
    .eq("type", "spending")
    .like("description", "Redeemed % (regenerated)")
    .order("member_id", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = data ?? [];
  console.log(`[audit] Fetched ${rows.length} "(regenerated)" spending rows.`);

  const byMember = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byMember.get(r.member_id) ?? [];
    arr.push(r);
    byMember.set(r.member_id, arr);
  }

  let clusters = 0;
  for (const [memberId, list] of byMember) {
    for (let i = 0; i < list.length - 1; i++) {
      const dtMs = new Date(list[i + 1]!.created_at).getTime() - new Date(list[i]!.created_at).getTime();
      if (dtMs > 0 && dtMs < 60_000) {
        clusters++;
        console.log(`  member=${memberId} dt=${dtMs}ms rows=${list[i]!.id},${list[i + 1]!.id}`);
      }
    }
  }
  console.log(`[audit] Found ${clusters} within-60s "(regenerated)" pairs (fingerprint of the double-deduct).`);
  console.log('[audit] Susan (aa8fe19e, ticket d19c2192) should appear above; she was corrected by hand.');
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--audit") ? "audit" : "dry-sim";
  if (mode === "audit") {
    await runReadOnlyAudit();
  } else {
    await runDrySimulator();
  }
}

main().catch((e) => { console.error(e); process.exit(1) });
