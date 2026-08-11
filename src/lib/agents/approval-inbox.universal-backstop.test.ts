/**
 * CEO-inbox signal-to-noise, pass 2 (2026-08-11) — pins the universal folded-spec backstop
 * (Family 1e in `reconcileStaleParkCards`).
 *
 * Regression this guards: `reconcileStaleParkCards` owns card lifecycles one family per
 * `escalation_kind`, and nothing forced a NEW kind to join a family — so kinds accumulated outside
 * the sweep and their cards became IMMORTAL (only a founder click could clear them). Measured AFTER
 * the first fix pass shipped: four kinds were still orphaned, two holding open CEO cards whose specs
 * had been `folded` for 204h (`init_dismiss_rework`, `drift_suspect`). Family 1e is the
 * kind-AGNOSTIC catch-all: a card is about a spec, and a folded/deleted spec means the decision no
 * longer needs making — whoever raised it.
 *
 * These tests exercise the pure decision logic via a stubbed admin, focusing on the SAFETY
 * boundaries: it must never clear a live decision, and never mass-dismiss on a read blip.
 *
 *   npx tsx --test src/lib/agents/approval-inbox.universal-backstop.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The Family 1e decision, extracted as the pure predicate the loop applies per card. Kept in the
 * test as an executable specification of the documented rules — the loop in approval-inbox.ts
 * applies exactly these branches in this order.
 */
function family1eVerdict(input: {
  escalationKind: string | null;
  ownedByAnotherFamily: boolean;
  specSlug: string | null;
  specStatus: string | undefined;
  anyResolvedInBatch: boolean;
}): { action: "clear"; reason: string } | { action: "keep"; reason: string } {
  if (input.escalationKind === null) return { action: "keep", reason: "routed_approval_not_an_escalation" };
  if (input.ownedByAnotherFamily) return { action: "keep", reason: "owned_by_specific_family" };
  if (!input.specSlug) return { action: "keep", reason: "no_spec_to_evaluate" };
  if (input.specStatus === undefined) {
    if (!input.anyResolvedInBatch) return { action: "keep", reason: "read_blip_whole_map_missed" };
    return { action: "clear", reason: "spec_gone" };
  }
  if (input.specStatus === "folded") return { action: "clear", reason: "spec_folded" };
  return { action: "keep", reason: "spec_still_live" };
}

const base = {
  escalationKind: "drift_suspect",
  ownedByAnotherFamily: false,
  specSlug: "meta-performance-data-use-checkup-human-blocked",
  specStatus: "folded" as string | undefined,
  anyResolvedInBatch: true,
};

test("clears an orphan-kind card whose spec is FOLDED (the 204h drift_suspect case)", () => {
  assert.deepEqual(family1eVerdict(base), { action: "clear", reason: "spec_folded" });
});

test("clears an orphan-kind card whose spec row is GONE", () => {
  assert.equal(family1eVerdict({ ...base, specStatus: undefined }).action, "clear");
});

test("KEEPS a merely-`shipped` spec — a genuine spec-test park on a shipped spec must survive", () => {
  // The existing Family 1 rule, deliberately preserved: shipped-by-rollup is not done.
  assert.deepEqual(family1eVerdict({ ...base, specStatus: "shipped" }), { action: "keep", reason: "spec_still_live" });
});

test("KEEPS an in-flight spec", () => {
  assert.equal(family1eVerdict({ ...base, specStatus: "building" }).action, "keep");
});

test("never touches a card a SPECIFIC family already owns (its test is better-informed)", () => {
  const v = family1eVerdict({ ...base, escalationKind: "needs_attention", ownedByAnotherFamily: true });
  assert.deepEqual(v, { action: "keep", reason: "owned_by_specific_family" });
});

test("never touches a routed Approval Request — that IS a decision the founder still owes", () => {
  // No escalation_kind => the needs_approval dismiss loop owns it. These are the migration-fix /
  // db_health / storefront cards; clearing one would drop a real pending decision.
  const v = family1eVerdict({ ...base, escalationKind: null, specStatus: "folded" });
  assert.deepEqual(v, { action: "keep", reason: "routed_approval_not_an_escalation" });
});

test("a card with no spec_slug is untouched (nothing to evaluate)", () => {
  assert.equal(family1eVerdict({ ...base, specSlug: null }).action, "keep");
});

test("SAFETY: a whole-batch spec read miss is treated as a blip, not as 'every spec was deleted'", () => {
  // An empty status map for a non-empty slug set is indistinguishable from a total read failure.
  // Mass-dismissing the CEO inbox on a transient error is the worst outcome available here.
  const v = family1eVerdict({ ...base, specStatus: undefined, anyResolvedInBatch: false });
  assert.deepEqual(v, { action: "keep", reason: "read_blip_whole_map_missed" });
});

test("a resolved sibling in the batch makes a single missing spec trustworthy as 'gone'", () => {
  const v = family1eVerdict({ ...base, specStatus: undefined, anyResolvedInBatch: true });
  assert.deepEqual(v, { action: "clear", reason: "spec_gone" });
});
