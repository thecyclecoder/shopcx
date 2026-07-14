/**
 * ads-supervisor tests — pins the Phase-2 split of the live-ad LF8 gate ([[./ads-supervisor]]).
 *
 * A keyword-thin verdict on its own is a NON-destructive Dahlia copy-enrichment suggestion
 * (kind `live_ad_lf8_thin_enrichment` — never authorizes is_active=false on the angle).
 * Only when the adset ALSO fails the leading-indicator gate (cost-per-ATC over the live
 * `iteration_policies.trim_max_cost_per_atc_cents` — the SAME SSOT Bianca's trim logic
 * reads at [[./media-buyer/agent]]) does the disposition escalate to the existing
 * deactivation-authorizing finding (kind `live_ad_lf8_thin`).
 *
 *   npx tsx --test src/lib/ads-supervisor.lf8-disposition.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ProductTestGroup, TestAdsetRow } from "@/lib/ads/testing-results-sdk";
import {
  isLiveAdLf8Underperforming,
  makeLiveAdLf8Finding,
  makeLiveAdLf8EnrichmentFinding,
  LF8_TRIM_MAX_COST_PER_ATC_DEFAULT_CENTS,
  resolveLf8UnderperformanceThreshold,
  chooseLf8Disposition,
} from "./ads-supervisor";

function makeRow(overrides: Partial<TestAdsetRow> = {}): TestAdsetRow {
  return {
    productId: "prod-1",
    productTitle: "Amazing Creamer",
    metaAccountId: "act_1",
    metaAccountName: "Superfoods",
    campaignId: "camp_1",
    adsetId: "120252355815780184",
    adsetName: "Creamer / collagen hook",
    effectiveStatus: "ACTIVE",
    active: true,
    spendCents: 25000,
    impressions: 10000,
    clicks: 200,
    addToCart: 5,
    purchases: 0,
    revenueCents: 0,
    cpmCents: 2500,
    ctrPct: 2.0,
    costPerAtcCents: 5000,
    cacCents: null,
    tier: "testing",
    lastDataDate: "2026-07-14",
    creative: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<ProductTestGroup> = {}): ProductTestGroup {
  return {
    productId: "prod-1",
    productTitle: "Amazing Creamer",
    metaAccountName: "Superfoods",
    campaignIds: ["camp_1"],
    rows: [],
    activeCount: 1,
    flags: [],
    ...overrides,
  };
}

const COPY_NO_LF8 = "single-origin arabica · 12 oz bag · medium roast";

test("LF8_TRIM_MAX_COST_PER_ATC_DEFAULT_CENTS matches Bianca's fallback default ($80)", () => {
  // Bianca's fallback in src/lib/media-buyer/agent.ts:933 is 8000 cents ($80). This module MUST
  // fall back to the SAME value when iteration_policies.trim_max_cost_per_atc_cents is null,
  // or the gate would silently diverge from the SSOT it's supposed to mirror.
  assert.equal(LF8_TRIM_MAX_COST_PER_ATC_DEFAULT_CENTS, 8000);
});

test("isLiveAdLf8Underperforming: cost-per-ATC over threshold → true (deactivation gate armed)", () => {
  // Cost-per-ATC is $110 vs a $80 threshold: this adset is failing the leading indicator.
  assert.equal(isLiveAdLf8Underperforming(makeRow({ costPerAtcCents: 11000 }), 8000), true);
});

test("isLiveAdLf8Underperforming: cost-per-ATC at or under threshold → false (enrichment only)", () => {
  // Exactly at threshold is NOT underperforming (spec says "exceeds").
  assert.equal(isLiveAdLf8Underperforming(makeRow({ costPerAtcCents: 8000 }), 8000), false);
  assert.equal(isLiveAdLf8Underperforming(makeRow({ costPerAtcCents: 5000 }), 8000), false);
});

test("isLiveAdLf8Underperforming: null cost-per-ATC (zero ATC yet) → false (no data → don't destroy)", () => {
  // The gate has to see a real leading-indicator failure. No ATC yet ⇒ we don't have data to
  // justify a destructive action; the disposition must fall back to the non-destructive
  // enrichment suggestion, NEVER the deactivation path.
  assert.equal(isLiveAdLf8Underperforming(makeRow({ costPerAtcCents: null, addToCart: 0 }), 8000), false);
});

test("makeLiveAdLf8EnrichmentFinding: non-destructive — kind is enrichment, body forbids destructive action", () => {
  const row = makeRow();
  const group = makeGroup();
  const finding = makeLiveAdLf8EnrichmentFinding(group, row, COPY_NO_LF8, 8000);
  assert.equal(finding.kind, "live_ad_lf8_thin_enrichment");
  assert.ok(
    finding.id !== `live-ad-lf8-${row.adsetId}`,
    "enrichment finding id must be distinct from the deactivation finding's id so both can be authored as separate fix-specs without slug collision",
  );
  // The prose must POSITIVELY guard the angle from destructive action. "Do NOT flip … is_active
  // = false" (or the sibling "Do NOT deactivate") is the guardrail phrasing; either satisfies.
  const combined = `${finding.why} ${finding.what} ${finding.body} ${finding.verification}`.toLowerCase();
  assert.ok(
    /do not (flip|deactivate)|strictly non-destructive|never a deactivation/.test(combined),
    `enrichment finding must positively guard against destructive action; got: ${combined.slice(0, 400)}`,
  );
  // AND the prose must NOT contain any deactivation-AUTHORIZING phrasing (contrast with the
  // deactivation-authorized `makeLiveAdLf8Finding`, whose body says "authorized" / "allowed").
  assert.ok(
    !/deactivation path is allowed|is_active flipped to false|is authorized|(authorized|allowed) to deactivate/.test(combined),
    `enrichment finding must not authorize deactivation; got: ${combined.slice(0, 400)}`,
  );
});

test("makeLiveAdLf8Finding (deactivation-authorized): only fires when underperforming — body cites the gate", () => {
  const row = makeRow({ costPerAtcCents: 11000 });
  const group = makeGroup();
  const finding = makeLiveAdLf8Finding(group, row, COPY_NO_LF8, 8000);
  assert.equal(finding.kind, "live_ad_lf8_thin");
  const combined = `${finding.why} ${finding.what} ${finding.body} ${finding.verification}`.toLowerCase();
  // The body of the deactivation path must cite the gate — a downstream fix-script reader must
  // see the underperformance predicate explicitly, so it cannot flip is_active=false on the
  // keyword miss alone.
  assert.ok(
    /cost[- ]per[- ]atc|trim_max_cost_per_atc/.test(combined),
    `deactivation finding must cite the cost-per-ATC gate; got: ${combined.slice(0, 400)}`,
  );
});

// ── Phase 3 (Fix 1 — fail-closed on iteration_policies read errors) ────────────
// Pre-merge spec-test security-review flagged a fail-OPEN bug: the resolver silently used the
// $80 default when the iteration_policies query erred OR returned no row, so a Supabase outage
// (or a workspace missing the row entirely) would silently authorize the destructive deactivation
// disposition. Fix: only use the default when a row is SUCCESSFULLY read AND the column value is
// null; on read error / no row the gate returns { ok: false } and the disposition falls to the
// non-destructive enrichment path regardless of the adset's cost-per-ATC.

/** Minimal chainable stub matching the Supabase call chain the resolver uses:
 *  admin.from().select().eq().order().limit(1).maybeSingle().
 *  Every intermediate returns the same chain; maybeSingle() resolves to the supplied result. */
function makeAdminMock(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const chainable = () => chain;
  chain.from = chainable;
  chain.select = chainable;
  chain.eq = chainable;
  chain.order = chainable;
  chain.limit = chainable;
  chain.maybeSingle = async () => result;
  return chain;
}

test("resolveLf8UnderperformanceThreshold: read ERROR → { ok: false } (fail-closed, no default)", async () => {
  const admin = makeAdminMock({ data: null, error: { message: "connection reset" } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await resolveLf8UnderperformanceThreshold(admin as any, "ws-1");
  assert.equal(result.ok, false, "read-error MUST NOT fall back to the default — that would be fail-open");
});

test("resolveLf8UnderperformanceThreshold: no row → { ok: false } (fail-closed, no default)", async () => {
  const admin = makeAdminMock({ data: null, error: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await resolveLf8UnderperformanceThreshold(admin as any, "ws-1");
  assert.equal(result.ok, false, "missing iteration_policies row MUST NOT fall back to the default — that would be fail-open");
});

test("resolveLf8UnderperformanceThreshold: row with null column → { ok: true, value: DEFAULT }", async () => {
  const admin = makeAdminMock({ data: { trim_max_cost_per_atc_cents: null }, error: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await resolveLf8UnderperformanceThreshold(admin as any, "ws-1");
  assert.deepEqual(result, { ok: true, value: LF8_TRIM_MAX_COST_PER_ATC_DEFAULT_CENTS });
});

test("resolveLf8UnderperformanceThreshold: row with concrete value → { ok: true, value: X }", async () => {
  const admin = makeAdminMock({ data: { trim_max_cost_per_atc_cents: 12000 }, error: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await resolveLf8UnderperformanceThreshold(admin as any, "ws-1");
  assert.deepEqual(result, { ok: true, value: 12000 });
});

test("chooseLf8Disposition: gate.ok=false → enrich_only REGARDLESS of cost-per-ATC (fail-closed)", () => {
  // A clearly-underperforming adset (cost-per-ATC $999.99, far above any real threshold) still
  // falls to enrichment when the gate could not be proven — the destructive path must NEVER be
  // authorized on a stale/erroring policy read.
  const row = makeRow({ costPerAtcCents: 99999 });
  assert.equal(chooseLf8Disposition({ ok: false, reason: "read error" }, row), "enrich_only");
});

test("chooseLf8Disposition: gate.ok=true + over threshold → deactivate_authorized", () => {
  const row = makeRow({ costPerAtcCents: 11000 });
  assert.equal(chooseLf8Disposition({ ok: true, value: 8000 }, row), "deactivate_authorized");
});

test("chooseLf8Disposition: gate.ok=true + at threshold → enrich_only", () => {
  const row = makeRow({ costPerAtcCents: 8000 });
  assert.equal(chooseLf8Disposition({ ok: true, value: 8000 }, row), "enrich_only");
});

test("chooseLf8Disposition: gate.ok=true + null cost-per-ATC → enrich_only (no data → don't destroy)", () => {
  const row = makeRow({ costPerAtcCents: null, addToCart: 0 });
  assert.equal(chooseLf8Disposition({ ok: true, value: 8000 }, row), "enrich_only");
});
