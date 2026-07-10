/**
 * Phase-2 idempotency test for the loyalty coupon-apply double-spend
 * (spec: loyalty-coupon-apply-self-heal-must-not-double-deduct-points).
 *
 * The bug (Phase 1): Susan D. (member aa8fe19e, ticket d19c2192) was
 * charged 1,500 pts TWICE within 12s on 2026-07-09 for ONE $15 coupon
 * — two "-1500 / Redeemed $X Off (regenerated)" `loyalty_transactions`
 * rows for one applied coupon. The mechanism: the regen branch inside
 * `apply_loyalty_coupon` (src/lib/action-executor.ts) has no idempotency
 * gate, so every verify-fail→retry re-enters mint+spendPoints.
 *
 * The fix: `claimRegenSpendSlot` compare-and-sets the orig redemption
 * from `active` → `expired` BEFORE mint. The first retry wins the row
 * and proceeds. Every later retry (finds the row already `expired`)
 * matches 0 rows and routes to `replaySuccessorApply` — no second spend
 * ever lands.
 *
 * These tests are pure — no live DB, no live Shopify. Two layers:
 *   (a) An in-memory replay of the regen branch's ledger writes that
 *       mirrors the NEW gated behavior. Assertions pin the fix: N
 *       retries → 1 spend; distinct applies → distinct spends.
 *   (b) A direct call to the real exported `claimRegenSpendSlot` against
 *       an in-memory admin fake modeled on the atomic-redeem-apply test.
 *       This locks in the compare-and-set semantics of the real writer.
 *
 * Run:
 *   npx tsx --test src/lib/action-executor.apply-loyalty-coupon-double-spend.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claimRegenSpendSlot } from "./action-executor";

// ─── In-memory ledger fixture ────────────────────────────────────────

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

type RegenOutcome =
  | { kind: "spent"; newCode: string }
  | { kind: "replay"; existingActiveCode: string };

/**
 * Gated in-memory replay of the regen branch's ledger writes, MIRRORING
 * the Phase-2 fix in action-executor.ts:
 *
 *   1. SELECT orig by discount_code (includes status now).
 *   2. If orig.status !== 'active' → early-out to REPLAY (no new spend).
 *   3. Compare-and-set claim: flip active → expired. If 0 rows match,
 *      route to REPLAY. Otherwise proceed to mint + spendPoints.
 *
 * Real code path: src/lib/action-executor.ts apply_loyalty_coupon regen
 * branch + `claimRegenSpendSlot` helper (also unit-tested directly
 * below with an in-memory admin).
 */
function runGatedRegenOnce(args: {
  workspaceId: string;
  code: string;
  members: MemberRow[];
  redemptions: RedemptionRow[];
  transactions: TxRow[];
  mintedCodeSuffix: string;
}): RegenOutcome {
  const { workspaceId, code, members, redemptions, transactions, mintedCodeSuffix } = args;

  const orig = redemptions.find(
    (r) => r.discount_code === code && r.workspace_id === workspaceId,
  );
  if (!orig) throw new Error(`orig not found for ${code}`);

  const findSuccessor = (): string => {
    // Newest active redemption for this member — the successor code the
    // completed regen minted. `replaySuccessorApply` retries against it.
    const actives = redemptions.filter(
      (r) => r.workspace_id === workspaceId && r.member_id === orig.member_id && r.status === "active",
    );
    // Newest first — mirror `.order('created_at', desc).limit(1)`.
    return actives[actives.length - 1]?.discount_code ?? "";
  };

  // Fast-bail (Phase 2 gate #1): orig.status !== 'active'.
  if (orig.status !== "active") {
    return { kind: "replay", existingActiveCode: findSuccessor() };
  }

  // Compare-and-set claim (Phase 2 gate #2). Single-threaded model here,
  // so once #1 lets us through, the claim always wins on the first pass.
  orig.status = "expired";

  // ── proceed to mint + spendPoints ──
  const member = members.find((m) => m.id === orig.member_id);
  if (!member) throw new Error("member not found");

  const newCode = `LOYALTY-${orig.discount_value}-${mintedCodeSuffix}`;
  const newDiscountId = `gid://shopify/DiscountCodeNode/${mintedCodeSuffix}`;

  member.points_balance = member.points_balance + orig.points_spent;
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

  redemptions.push({
    id: `red-${mintedCodeSuffix}`,
    workspace_id: workspaceId,
    member_id: member.id,
    discount_code: newCode,
    discount_value: orig.discount_value,
    points_spent: orig.points_spent,
    status: "active",
  });

  return { kind: "spent", newCode };
}

function seedSusanState(): {
  member: MemberRow;
  redemptions: RedemptionRow[];
  transactions: TxRow[];
  origCode: string;
} {
  const member: MemberRow = {
    id: "mem-susan",
    workspace_id: "ws-superfoods",
    points_balance: 500,
    points_spent: 1500,
  };
  const origCode = "LOYALTY-15-OLDXYZ";
  const redemptions: RedemptionRow[] = [{
    id: "red-orig",
    workspace_id: "ws-superfoods",
    member_id: "mem-susan",
    discount_code: origCode,
    discount_value: 15,
    points_spent: 1500,
    status: "active",
  }];
  return { member, redemptions, transactions: [], origCode };
}

// ─── Behavioral assertions on the gated ledger replay ─────────────────

test("FIX: two regen attempts for the SAME original code produce EXACTLY ONE -1500 spending row (Susan's Jul 09 fingerprint)", () => {
  const { member, redemptions, transactions, origCode } = seedSusanState();

  const out1 = runGatedRegenOnce({
    workspaceId: "ws-superfoods",
    code: origCode,
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "AAA111",
  });

  const out2 = runGatedRegenOnce({
    workspaceId: "ws-superfoods",
    code: origCode, // caller-level retry with the ORIGINAL code — was the bug's entry point
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "BBB222",
  });

  const spends = transactions.filter(
    (t) => t.points_change === -1500 && t.type === "spending" && t.description.includes("(regenerated)"),
  );
  assert.equal(spends.length, 1, "Phase-2 gate must produce EXACTLY ONE spend for a verify-fail→retry (was 2 pre-fix)");
  assert.equal(out1.kind, "spent", "first attempt claims the slot and spends once");
  assert.equal(out2.kind, "replay", "second attempt finds orig no longer active → routes to idempotent replay");
  assert.equal(member.points_spent, 3000, "points_spent = 1500 (initial redeem) + 1500 (one regen) — no inflation");
  const activeRedemptions = redemptions.filter((r) => r.status === "active");
  assert.equal(activeRedemptions.length, 1, "applied_discounts mirror stays consistent — one live coupon after the retry");
  if (out2.kind === "replay") {
    assert.equal(out2.existingActiveCode, activeRedemptions[0]!.discount_code, "replay targets the sole active successor code");
  }
});

test("FIX: three regen attempts for the same original code STILL produce EXACTLY ONE spend", () => {
  const { member, redemptions, transactions, origCode } = seedSusanState();
  const outcomes: RegenOutcome[] = [];
  for (const suffix of ["AAA", "BBB", "CCC"]) {
    outcomes.push(runGatedRegenOnce({
      workspaceId: "ws-superfoods",
      code: origCode,
      members: [member],
      redemptions,
      transactions,
      mintedCodeSuffix: suffix,
    }));
  }
  const spends = transactions.filter(
    (t) => t.points_change === -1500 && t.type === "spending" && t.description.includes("(regenerated)"),
  );
  assert.equal(spends.length, 1, "unbounded retry loop is gated — the ledger stops at one spend even under 3× retries");
  assert.equal(outcomes.filter((o) => o.kind === "spent").length, 1);
  assert.equal(outcomes.filter((o) => o.kind === "replay").length, 2);
});

test("baseline: a SINGLE regen attempt still produces one spend and one active successor (the legitimate self-heal path is preserved)", () => {
  const { member, redemptions, transactions, origCode } = seedSusanState();
  const out = runGatedRegenOnce({
    workspaceId: "ws-superfoods",
    code: origCode,
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "ONCE",
  });
  const spends = transactions.filter(
    (t) => t.points_change === -1500 && t.type === "spending" && t.description.includes("(regenerated)"),
  );
  assert.equal(spends.length, 1, "one regen = one spend");
  assert.equal(out.kind, "spent");
  const activeRedemptions = redemptions.filter((r) => r.status === "active");
  assert.equal(activeRedemptions.length, 1, "one live successor coupon after a legitimate self-heal");
});

test("NEGATIVE: two DISTINCT coupon applies still produce two spends (idempotency is keyed per apply, does NOT globally suppress legitimate second spends)", () => {
  // Two different tickets over time, each with its own original code.
  // The Phase-2 gate must NOT suppress the second spend — it's a
  // separate applied coupon, so it deserves a separate points spend.
  const member: MemberRow = {
    id: "mem-alex",
    workspace_id: "ws-superfoods",
    points_balance: 6000,
    points_spent: 0,
  };
  const redemptions: RedemptionRow[] = [
    { id: "red-A", workspace_id: "ws-superfoods", member_id: "mem-alex",
      discount_code: "LOYALTY-15-CODEAA", discount_value: 15, points_spent: 1500, status: "active" },
    { id: "red-B", workspace_id: "ws-superfoods", member_id: "mem-alex",
      discount_code: "LOYALTY-15-CODEBB", discount_value: 15, points_spent: 1500, status: "active" },
  ];
  const transactions: TxRow[] = [];

  const outA = runGatedRegenOnce({
    workspaceId: "ws-superfoods",
    code: "LOYALTY-15-CODEAA",
    members: [member], redemptions, transactions,
    mintedCodeSuffix: "A1",
  });
  const outB = runGatedRegenOnce({
    workspaceId: "ws-superfoods",
    code: "LOYALTY-15-CODEBB",
    members: [member], redemptions, transactions,
    mintedCodeSuffix: "B1",
  });

  assert.equal(outA.kind, "spent");
  assert.equal(outB.kind, "spent");
  const spends = transactions.filter(
    (t) => t.points_change === -1500 && t.type === "spending" && t.description.includes("(regenerated)"),
  );
  assert.equal(spends.length, 2, "two DISTINCT applies → two DISTINCT spends; the gate keys per orig code, not globally per member");
});

// ─── Direct test on the REAL exported `claimRegenSpendSlot` helper ────

type FakeRow = Record<string, unknown>;
type FakeTables = Record<string, FakeRow[]>;

interface FakeChain {
  select: (cols?: string) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  update: (patch: FakeRow) => FakeChain;
  then: <TResult>(
    onFulfilled?: (v: { data: FakeRow[] | null; error: null }) => TResult | PromiseLike<TResult>,
  ) => Promise<TResult>;
}

function makeFakeChain(tables: FakeTables, table: string): FakeChain {
  const filters: Array<{ col: string; val: unknown }> = [];
  let pendingUpdate: FakeRow | null = null;
  let selectRequested = false;
  const chain: FakeChain = {
    select: () => { selectRequested = true; return chain },
    eq: (col, val) => { filters.push({ col, val }); return chain },
    update: (patch) => { pendingUpdate = { ...patch }; return chain },
    then: (onFulfilled) => {
      let matchedRows: FakeRow[] = [];
      if (pendingUpdate) {
        const all = tables[table] ?? [];
        matchedRows = all.filter((r) => filters.every((f) => r[f.col] === f.val));
        for (const row of matchedRows) Object.assign(row, pendingUpdate);
        pendingUpdate = null;
      }
      const data = selectRequested ? matchedRows.map((r) => ({ id: r.id })) : null;
      return Promise.resolve({ data, error: null } as { data: FakeRow[] | null; error: null }).then(onFulfilled);
    },
  };
  return chain;
}

function makeFakeAdmin(tables: FakeTables): { from: (t: string) => FakeChain } {
  return { from: (t) => makeFakeChain(tables, t) };
}

test("claimRegenSpendSlot: compare-and-set claims an ACTIVE row and returns true", async () => {
  const tables: FakeTables = {
    loyalty_redemptions: [
      { id: "red-1", workspace_id: "ws-1", status: "active" },
    ],
  };
  const admin = makeFakeAdmin(tables);
  const won = await claimRegenSpendSlot(admin as unknown as Parameters<typeof claimRegenSpendSlot>[0], "ws-1", "red-1");
  assert.equal(won, true, "first caller wins the slot");
  assert.equal(tables.loyalty_redemptions[0]!.status, "expired", "the winning update flipped the row to expired");
});

test("claimRegenSpendSlot: a second call on the SAME row returns false (row is already expired — no second spend allowed)", async () => {
  const tables: FakeTables = {
    loyalty_redemptions: [
      { id: "red-1", workspace_id: "ws-1", status: "active" },
    ],
  };
  const admin = makeFakeAdmin(tables);
  const first = await claimRegenSpendSlot(admin as unknown as Parameters<typeof claimRegenSpendSlot>[0], "ws-1", "red-1");
  const second = await claimRegenSpendSlot(admin as unknown as Parameters<typeof claimRegenSpendSlot>[0], "ws-1", "red-1");
  assert.equal(first, true);
  assert.equal(second, false, "the caller MUST NOT enter mint+spendPoints on lose — routes to replaySuccessorApply");
});

test("claimRegenSpendSlot: an already-NON-active row returns false immediately (fast bail without any transition)", async () => {
  const tables: FakeTables = {
    loyalty_redemptions: [
      { id: "red-1", workspace_id: "ws-1", status: "expired" },
    ],
  };
  const admin = makeFakeAdmin(tables);
  const won = await claimRegenSpendSlot(admin as unknown as Parameters<typeof claimRegenSpendSlot>[0], "ws-1", "red-1");
  assert.equal(won, false);
  assert.equal(tables.loyalty_redemptions[0]!.status, "expired", "no unnecessary write on the losing branch");
});

test("claimRegenSpendSlot: wrong workspace_id cannot claim the row (cross-workspace guard)", async () => {
  const tables: FakeTables = {
    loyalty_redemptions: [
      { id: "red-1", workspace_id: "ws-1", status: "active" },
    ],
  };
  const admin = makeFakeAdmin(tables);
  const won = await claimRegenSpendSlot(admin as unknown as Parameters<typeof claimRegenSpendSlot>[0], "ws-2", "red-1");
  assert.equal(won, false, "the workspace_id predicate in the write blocks cross-workspace claims");
  assert.equal(tables.loyalty_redemptions[0]!.status, "active");
});
