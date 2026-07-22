/**
 * seed-angle-palette tests — pin the Phase-1 contract:
 *   (i)   a non-advertised product is REFUSED (the advertised-products chokepoint gate)
 *   (ii)  lanes are filtered by the product's ingredients (matcher subset check)
 *   (iii) every seeded row lands with is_active=false + source='seeded' + demand from the sweep +
 *         a stamped provenance note (never by-fiat)
 *   (iv)  the seeder never touches product_angle_palette outside the angle-palette SDK
 *   (v)   the search-demand tier is read from the sweep provider — swapping the provider changes
 *         the recorded tier (proof that scoring is not hardcoded in the seeder)
 *
 * Pure unit tests — no supabase pooler, no network.
 *
 * Run: npx tsx --test src/lib/ads/seed-angle-palette.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROBLEM_LANES,
  seedProductAnglePalette,
  formatSeededTable,
} from "./seed-angle-palette";
import {
  setSearchDemandProvider,
  resetSearchDemandProvider,
  type SearchDemandProvider,
} from "./angle-demand-sweep";

interface CapturedWrite {
  op: "upsert" | "update" | "insert";
  table: string;
  row?: Record<string, unknown>;
  onConflict?: string;
}

/**
 * Fake admin — handles the two SDK surfaces the seeder touches:
 *   • products (isAdvertisedProduct → select/eq/maybeSingle)
 *   • product_angle_palette (upsertAngle → upsert/select/single)
 * Any other .from() lookup returns empty defaults so a stray read cannot silently corrupt the
 * assertion (a raw .from('product_angle_palette').update(...) would land in `writes` and be
 * inspected by the "SDK only" test).
 */
function makeAdmin(opts: {
  advertised: boolean;
}): { admin: unknown; writes: CapturedWrite[]; queriedTables: string[] } {
  const writes: CapturedWrite[] = [];
  const queriedTables: string[] = [];
  const admin = {
    from(table: string) {
      queriedTables.push(table);
      if (table === "products") {
        const builder = {
          select: (_c: string) => builder,
          eq: (_c: string, _v: unknown) => builder,
          maybeSingle: () => Promise.resolve({ data: { is_advertised: opts.advertised }, error: null }),
        };
        return builder;
      }
      if (table === "product_angle_palette") {
        const builder = {
          upsert(row: Record<string, unknown>, upsertOpts: { onConflict?: string }) {
            writes.push({ op: "upsert", table, row, onConflict: upsertOpts.onConflict });
            return {
              select(_c: string) {
                return {
                  single() {
                    return Promise.resolve({ data: { id: `angle-${writes.length}` }, error: null });
                  },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            writes.push({ op: "update", table, row: patch });
            return {
              eq: (_c: string, _v: unknown) => Promise.resolve({ error: null }),
            };
          },
        };
        return builder;
      }
      // fallback — any other table read/write shape returns empty defaults.
      const fallback = {
        select: (_c: string) => fallback,
        eq: (_c: string, _v: unknown) => fallback,
        order: () => fallback,
        ilike: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return fallback;
    },
  };
  return { admin, writes, queriedTables };
}

test("(i) refuses a non-advertised product — the advertised-products chokepoint gate", async () => {
  resetSearchDemandProvider();
  const { admin, writes } = makeAdmin({ advertised: false });
  await assert.rejects(
    () => seedProductAnglePalette({
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-attachment",
      ingredientNames: ["collagen"],
    }),
    /is not is_advertised/i,
  );
  assert.equal(writes.length, 0, "no palette rows written on a rejected product");
});

test("(ii) lanes filter to the ingredients the product carries — no upsert for lanes whose matchers miss", async () => {
  resetSearchDemandProvider();
  const { admin, writes } = makeAdmin({ advertised: true });
  const summary = await seedProductAnglePalette({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["Collagen Peptides"], // only collagen — mct/ashwagandha/creatine lanes must skip
  });
  const collagenLanes = PROBLEM_LANES.filter((l) => l.ingredientMatchers.every((m) => "collagen peptides".includes(m)));
  assert.equal(summary.rowsUpserted, collagenLanes.length);
  assert.equal(summary.lanesMatched, collagenLanes.length);
  assert.equal(writes.length, collagenLanes.length);
  // No lane that requires a matcher this product doesn't have should have been upserted.
  const seededProblems = new Set(summary.seeded.map((s) => s.problem));
  for (const lane of PROBLEM_LANES) {
    const shouldMatch = lane.ingredientMatchers.every((m) => "collagen peptides".includes(m));
    if (!shouldMatch) {
      assert.ok(!seededProblems.has(lane.problem), `lane ${lane.problem} must NOT have been seeded (no matcher hit)`);
    }
  }
});

test("(iii) every seeded row lands is_active=false + source='seeded' + demand from the sweep + a stamped provenance note", async () => {
  const highProvider: SearchDemandProvider = async () => ({ tier: "high", rawVolume: 4200, source: "test-provider" });
  setSearchDemandProvider(highProvider);
  const { admin, writes } = makeAdmin({ advertised: true });
  await seedProductAnglePalette({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen", "hyaluronic acid", "mct oil", "ashwagandha", "creatine", "coffee", "spirulina", "chlorella"],
  });
  const upserts = writes.filter((w) => w.op === "upsert" && w.table === "product_angle_palette");
  assert.ok(upserts.length > 0);
  for (const u of upserts) {
    // Spec verification #4: drafts land inactive so a human must promote them.
    assert.equal(u.row!.is_active, false, "sweep/seeder NEVER writes is_active=true");
    assert.equal(u.row!.source, "seeded");
    assert.equal(u.row!.search_demand, "high", "the tier comes from the sweep provider (evidence-grounded)");
    assert.equal(u.onConflict, "workspace_id,product_id,theme,problem", "upsert is on the natural key");
    assert.ok(String(u.row!.notes).includes("seed-angle-palette"), "notes stamps the seeder provenance");
    assert.ok(String(u.row!.notes).includes("source=test-provider"), "notes carries the demand provider");
  }
  resetSearchDemandProvider();
});

test("(iv) SDK-only: the seeder only reads/writes product_angle_palette via the angle-palette SDK (upsertAngle) — no raw update/delete or unknown mutation ops", async () => {
  resetSearchDemandProvider();
  const { admin, writes } = makeAdmin({ advertised: true });
  await seedProductAnglePalette({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen"],
  });
  const paletteWrites = writes.filter((w) => w.table === "product_angle_palette");
  assert.ok(paletteWrites.length > 0);
  // Every mutation to product_angle_palette must be an upsert (the SDK's chokepoint). A raw
  // `.from('product_angle_palette').update(...)` or delete would land in writes as op:'update' —
  // fail the test loudly if any surfaces.
  for (const w of paletteWrites) {
    assert.equal(w.op, "upsert", `only upsertAngle is allowed to write product_angle_palette; saw op=${w.op}`);
  }
});

test("(v) swapping the demand provider swaps the tier stamped on every seeded row (the seeder does NOT score by fiat)", async () => {
  const lowProvider: SearchDemandProvider = async () => ({ tier: "low", rawVolume: 5, source: "low-provider" });
  setSearchDemandProvider(lowProvider);
  const { admin } = makeAdmin({ advertised: true });
  const summary = await seedProductAnglePalette({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen"],
  });
  for (const a of summary.seeded) {
    assert.equal(a.searchDemand, "low", "swapped provider → every seeded row's demand tier reflects it");
    assert.equal(a.demandSource, "low-provider");
  }
  resetSearchDemandProvider();
});

test("advertised gate is bypassable only via the explicit test seam (skipAdvertisedGate=true)", async () => {
  resetSearchDemandProvider();
  const { admin } = makeAdmin({ advertised: false });
  const summary = await seedProductAnglePalette({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen"],
    skipAdvertisedGate: true,
  });
  assert.ok(summary.rowsUpserted > 0, "with the test seam the gate is bypassed");
});

test("formatSeededTable produces a plain-text table an operator can scan", () => {
  const table = formatSeededTable({
    productId: "prod-1",
    advertised: true,
    ingredientNames: ["collagen"],
    lanesConsidered: PROBLEM_LANES.length,
    lanesMatched: 1,
    rowsUpserted: 1,
    provider: "stub",
    seeded: [{
      angleId: "a-1",
      theme: "beauty",
      problem: "wrinkles and aging skin",
      ingredientMatched: "collagen",
      searchDemand: "medium",
      demandSource: "stub",
      promoted: false,
    }],
  });
  assert.ok(table.includes("theme"));
  assert.ok(table.includes("beauty"));
  assert.ok(table.includes("wrinkles"));
  assert.ok(table.includes("false"));
});
