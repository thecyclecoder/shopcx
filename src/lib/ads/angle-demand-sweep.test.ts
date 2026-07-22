/**
 * angle-demand-sweep tests — pin the Phase-1 provider SDK's contract:
 *   (i)   known-high volume in product_seo_keywords → tier:'high' + source:'product_seo_keywords'
 *   (ii)  unknown ingredient (no matching rows) → the provider hook fires (default: stub)
 *   (iii) sensitive column names cannot be smuggled via the arg surface (defense-in-depth) —
 *         the SDK's select column list is fixed regardless of caller input.
 *
 * Also covers the tier boundaries + tokenizer + provider swap so a future paid-source spec has
 * a green baseline to build on. Pure unit tests — no supabase pooler, no network.
 *
 * Run: npx tsx --test src/lib/ads/angle-demand-sweep.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchSearchDemand,
  tierForVolume,
  problemTokens,
  setSearchDemandProvider,
  resetSearchDemandProvider,
  HIGH_MIN_VOLUME,
  MEDIUM_MIN_VOLUME,
  stubProvider,
  PROBLEM_LANES,
  runSweepForProduct,
  type SearchDemandProvider,
} from "./angle-demand-sweep";

interface CapturedQuery {
  table: string;
  selectCols: string;
  filters: Array<{ op: string; column: string; value: unknown }>;
}

/** Fake admin — captures the .from().select().eq().ilike() chain against product_seo_keywords
 *  and resolves with the fixed row set the test supplies. Sufficient for the SDK's single
 *  read path; no other Supabase methods are exercised. */
function makeFakeAdmin(rowsByTable: Record<string, unknown[]>): { admin: unknown; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const admin = {
    from(table: string) {
      const q: CapturedQuery = { table, selectCols: "", filters: [] };
      queries.push(q);
      const builder = {
        select(cols: string) {
          q.selectCols = cols;
          return builder;
        },
        eq(column: string, value: unknown) {
          q.filters.push({ op: "eq", column, value });
          return builder;
        },
        ilike(column: string, value: unknown) {
          q.filters.push({ op: "ilike", column, value });
          return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
        },
      };
      return builder;
    },
  };
  return { admin, queries };
}

test("(i) a keyword row with volume >= HIGH_MIN_VOLUME → tier:'high' + rawVolume + source:'product_seo_keywords'", async () => {
  resetSearchDemandProvider();
  const { admin } = makeFakeAdmin({
    product_seo_keywords: [
      { keyword: "collagen wrinkles serum", monthly_searches: 4200, search_console_impressions: 300 },
      { keyword: "collagen sleep", monthly_searches: 50, search_console_impressions: null },
    ],
  });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "collagen",
    problem: "wrinkles and aging skin",
  });
  assert.equal(out.tier, "high");
  assert.equal(out.rawVolume, 4500); // 4200 + 300, the max matching row (the "collagen sleep" row doesn't match the "wrinkles" problem token)
  assert.equal(out.source, "product_seo_keywords");
});

test("(ii) unknown ingredient (no matching product_seo_keywords row) → the stub provider fires", async () => {
  resetSearchDemandProvider();
  const { admin, queries } = makeFakeAdmin({ product_seo_keywords: [] });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "hypothetical-unicorn-mushroom",
    problem: "cosmic clarity",
  });
  assert.equal(out.tier, "medium");
  assert.equal(out.rawVolume, null);
  assert.equal(out.source, "stub");
  // The read STILL went to product_seo_keywords (empty result) before the stub fell through.
  assert.equal(queries[0]?.table, "product_seo_keywords");
});

test("(iii) defense-in-depth: the arg surface cannot smuggle a select list — the SDK reads a FIXED column set regardless of input", async () => {
  resetSearchDemandProvider();
  const { admin, queries } = makeFakeAdmin({ product_seo_keywords: [] });
  // Even with an adversarial ingredient string that resembles a Postgres identifier, the SDK
  // must NEVER echo it into the SELECT/FILTER surface as an identifier — it can only appear as
  // a bound VALUE inside the ilike pattern.
  const adversarial = "keyword; select * from workspaces --";
  await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: adversarial,
    problem: "wrinkles",
  });
  const q = queries[0]!;
  assert.equal(q.table, "product_seo_keywords");
  // Fixed allowlist — no dynamic column, no SELECT *.
  assert.equal(q.selectCols, "keyword, monthly_searches, search_console_impressions");
  const ilike = q.filters.find((f) => f.op === "ilike");
  assert.ok(ilike, "ilike filter must be present");
  assert.equal(ilike!.column, "keyword", "the ilike column is fixed to `keyword`, never derived from input");
  assert.equal(ilike!.value, `%${adversarial}%`, "input goes into the VALUE side of a bound parameter, never the identifier side");
  const eq = q.filters.find((f) => f.op === "eq" && f.column === "workspace_id");
  assert.ok(eq, "workspace_id scope must always be applied");
  assert.equal(eq!.value, "ws-1");
});

test("tier boundaries: 999 -> medium, 1000 -> high, 100 -> medium, 99 -> low", () => {
  assert.equal(tierForVolume(HIGH_MIN_VOLUME - 1), "medium");
  assert.equal(tierForVolume(HIGH_MIN_VOLUME), "high");
  assert.equal(tierForVolume(MEDIUM_MIN_VOLUME), "medium");
  assert.equal(tierForVolume(MEDIUM_MIN_VOLUME - 1), "low");
  assert.equal(tierForVolume(0), "low");
});

test("named constants stay tunable (not magic numbers) — HIGH_MIN_VOLUME=1000, MEDIUM_MIN_VOLUME=100", () => {
  assert.equal(HIGH_MIN_VOLUME, 1000);
  assert.equal(MEDIUM_MIN_VOLUME, 100);
});

test("problemTokens drops stopwords + short tokens and lowercases", () => {
  assert.deepEqual(problemTokens("Wrinkles and Aging Skin"), ["wrinkles", "aging", "skin"]);
  assert.deepEqual(problemTokens("gut  --  bloating!!"), ["gut", "bloating"]);
  assert.deepEqual(problemTokens(""), []);
});

test("stubProvider returns the neutral medium tier so a demand-blind lane doesn't score high by accident", async () => {
  const out = await stubProvider({ workspaceId: "ws-1", ingredient: "x", problem: "y" });
  assert.deepEqual(out, { tier: "medium", rawVolume: null, source: "stub" });
});

test("setSearchDemandProvider swaps the hook (future paid-source spec) — resetSearchDemandProvider restores the stub", async () => {
  const custom: SearchDemandProvider = async () => ({ tier: "low", rawVolume: 7, source: "test-provider" });
  setSearchDemandProvider(custom);
  const { admin } = makeFakeAdmin({ product_seo_keywords: [] });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "collagen",
    problem: "wrinkles",
  });
  assert.deepEqual(out, { tier: "low", rawVolume: 7, source: "test-provider" });
  resetSearchDemandProvider();
  const out2 = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "collagen",
    problem: "wrinkles",
  });
  assert.equal(out2.source, "stub");
});

test("empty ingredient short-circuits to the provider (never reads product_seo_keywords)", async () => {
  resetSearchDemandProvider();
  const { admin, queries } = makeFakeAdmin({ product_seo_keywords: [] });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "   ",
    problem: "wrinkles",
  });
  assert.equal(out.source, "stub");
  assert.equal(queries.length, 0, "no DB read happens for an empty ingredient — the provider handles it");
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — runSweepForProduct + PROBLEM_LANES contract tests
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedWrite {
  op: "upsert" | "update" | "insert";
  table: string;
  row?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  onConflict?: string;
  eqFilters?: Array<{ column: string; value: unknown }>;
}

/**
 * Richer fake admin — handles the sweep's four DB surfaces:
 *   • product_seo_keywords → select/eq/ilike returning caller-supplied rows
 *   • product_angle_palette → select/eq/order (listAnglePalette), upsert/select/single (upsertAngle),
 *     update/eq (refreshAngleSearchDemand)
 *   • director_activity → insert (recordDirectorActivity)
 * Everything else falls through with sane defaults so no accidental crash.
 */
function makeSweepAdmin(opts: {
  seoKeywords?: unknown[];
  existingPaletteRows?: Array<Record<string, unknown>>;
}): { admin: unknown; writes: CapturedWrite[] } {
  const writes: CapturedWrite[] = [];
  const admin = {
    from(table: string) {
      if (table === "product_seo_keywords") {
        const builder = {
          select: (_c: string) => builder,
          eq: (_c: string, _v: unknown) => builder,
          ilike: (_c: string, _v: unknown) =>
            Promise.resolve({ data: opts.seoKeywords ?? [], error: null }),
        };
        return builder;
      }
      if (table === "product_angle_palette") {
        // select-then-eq-then-order (listAnglePalette path)
        // AND upsert-then-select-then-single (upsertAngle path)
        // AND update-then-eq (refreshAngleSearchDemand path)
        const builder = {
          select: (_c: string) => {
            const s = {
              _eq: [] as Array<{ column: string; value: unknown }>,
              eq(col: string, val: unknown) { s._eq.push({ column: col, value: val }); return s; },
              order(_col: string, _opts?: unknown) { return s; },
              then(resolve: (r: { data: unknown[]; error: null }) => void) {
                // list-path terminal — return the fixture rows filtered by is_active if requested.
                const isActiveFilter = s._eq.find((f) => f.column === "is_active");
                const rows = (opts.existingPaletteRows ?? []).filter((r) => {
                  if (isActiveFilter !== undefined && r.is_active !== isActiveFilter.value) return false;
                  return true;
                });
                resolve({ data: rows, error: null });
              },
            };
            return s;
          },
          upsert(row: Record<string, unknown>, upsertOpts: { onConflict?: string }) {
            const write: CapturedWrite = { op: "upsert", table, row, onConflict: upsertOpts.onConflict };
            writes.push(write);
            return {
              select(_c: string) {
                return {
                  single() { return Promise.resolve({ data: { id: `angle-${writes.length}` }, error: null }); },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            const write: CapturedWrite = { op: "update", table, patch, eqFilters: [] };
            writes.push(write);
            return {
              eq(column: string, value: unknown) {
                write.eqFilters!.push({ column, value });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
        return builder;
      }
      if (table === "director_activity") {
        return {
          insert(row: Record<string, unknown>) {
            writes.push({ op: "insert", table, row });
            return Promise.resolve({ error: null });
          },
        };
      }
      // Fallback — should not be hit if ingredientNames is injected.
      const fallback = {
        select: (_c: string) => fallback,
        eq: (_c: string, _v: unknown) => fallback,
        order: () => fallback,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return fallback;
    },
  };
  return { admin, writes };
}

test("runSweepForProduct: high-tier NEW lane → is_active=false, source=dahlia_fanned draft (owner promotes)", async () => {
  // A provider that always answers "high" so every lane-with-no-existing-row becomes a draft.
  const highProvider: SearchDemandProvider = async () => ({ tier: "high", rawVolume: 4200, source: "test-provider" });
  setSearchDemandProvider(highProvider);
  const { admin, writes } = makeSweepAdmin({ existingPaletteRows: [] });
  const summary = await runSweepForProduct({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen"],
  });
  assert.equal(summary.rowsRefreshed, 0);
  assert.equal(summary.draftsCreated, PROBLEM_LANES.length, "every lane with no match + tier:high → one draft");
  const drafts = writes.filter((w) => w.op === "upsert" && w.table === "product_angle_palette");
  assert.equal(drafts.length, PROBLEM_LANES.length);
  for (const d of drafts) {
    // The whole spec turns on this: a sweep-authored draft MUST NOT be active — the owner gates it.
    assert.equal(d.row!.is_active, false, "sweep NEVER writes is_active=true");
    assert.equal(d.row!.source, "dahlia_fanned");
    assert.equal(d.row!.evidence_tier, "customer_only");
    assert.equal(d.row!.search_demand, "high");
    assert.deepEqual(d.row!.ingredients, ["collagen"]);
    assert.equal(d.onConflict, "workspace_id,product_id,theme,problem");
    assert.ok(String(d.row!.notes).includes("angle-demand-sweep"), "notes carries sweep provenance");
  }
  resetSearchDemandProvider();
});

test("runSweepForProduct: medium/low tier + no existing row → NO draft (only high-tier lanes surface a new row)", async () => {
  // Low tier — the provider says "no genuine demand". Sweep must skip the draft.
  const lowProvider: SearchDemandProvider = async () => ({ tier: "low", rawVolume: 5, source: "test-provider" });
  setSearchDemandProvider(lowProvider);
  const { admin, writes } = makeSweepAdmin({ existingPaletteRows: [] });
  const summary = await runSweepForProduct({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen"],
  });
  assert.equal(summary.draftsCreated, 0, "low-tier lanes with no existing row are silently skipped — no palette pollution");
  assert.equal(summary.rowsRefreshed, 0);
  const upserts = writes.filter((w) => w.op === "upsert");
  assert.equal(upserts.length, 0);
  resetSearchDemandProvider();
});

test("runSweepForProduct: existing palette row → refresh path updates search_demand + notes ONLY (never touches is_active / enemy / mechanism)", async () => {
  const highProvider: SearchDemandProvider = async () => ({ tier: "high", rawVolume: 9999, source: "test-provider" });
  setSearchDemandProvider(highProvider);
  // A previously-seeded row for the beauty/wrinkles lane — the sweep must refresh, not clobber.
  const seedRow = {
    id: "seed-angle-1",
    product_id: "prod-1",
    theme: "beauty",
    problem: "wrinkles and aging skin",
    ingredients: ["collagen", "hyaluronic_acid"],
    enemy: "serums",
    mechanism: "collagen rebuilds skin from within",
    proof_text: "35% wrinkle reduction",
    evidence_tier: "science_strong",
    search_demand: "medium",
    awareness_stages: ["cold", "warm", "hot"],
    source: "seeded",
    times_used: 4,
    last_used_at: null,
    status: "fresh",
    is_active: true, // the seeded row was owner-active; the sweep MUST leave that alone.
    display_order: 0,
    notes: "seeded 2026-07-01",
    benefit_key: null,
    desired_outcome: null,
    proof_kind: null,
    backing_review_ids: [],
  };
  const { admin, writes } = makeSweepAdmin({ existingPaletteRows: [seedRow] });
  const summary = await runSweepForProduct({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen"],
  });
  assert.equal(summary.rowsRefreshed, 1, "the seeded row got refreshed exactly once");
  // The rest of the high-tier lanes with no existing row → drafts (that's normal, tested above).
  const updates = writes.filter((w) => w.op === "update" && w.table === "product_angle_palette");
  assert.equal(updates.length, 1);
  const patch = updates[0]!.patch!;
  // Refresh writes ONLY these keys — never is_active/enemy/mechanism/proof/source/status.
  const patchedKeys = Object.keys(patch).sort();
  assert.deepEqual(patchedKeys, ["notes", "search_demand", "updated_at"], "refresh is scoped to (search_demand, notes, updated_at) — nothing else");
  assert.equal(patch.search_demand, "high");
  assert.ok(String(patch.notes).includes("angle-demand-sweep"));
  // The eq filter targets the exact angle id (compare-and-set on the row we read).
  assert.equal(updates[0]!.eqFilters![0]?.column, "id");
  assert.equal(updates[0]!.eqFilters![0]?.value, "seed-angle-1");
  // Confirm ZERO upsert touched the beauty/wrinkles lane (the refresh path handled it).
  const collidingUpserts = writes.filter((w) =>
    w.op === "upsert" && w.table === "product_angle_palette" &&
    w.row!.theme === "beauty" && w.row!.problem === "wrinkles and aging skin");
  assert.equal(collidingUpserts.length, 0, "the refresh path handled the seeded lane; no upsert collided");
  resetSearchDemandProvider();
});

test("runSweepForProduct: writes ONE director_activity audit row per run summarizing counts + provider", async () => {
  const highProvider: SearchDemandProvider = async () => ({ tier: "high", rawVolume: 4200, source: "test-provider" });
  setSearchDemandProvider(highProvider);
  const { admin, writes } = makeSweepAdmin({ existingPaletteRows: [] });
  const summary = await runSweepForProduct({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen", "matcha"],
  });
  const auditInserts = writes.filter((w) => w.op === "insert" && w.table === "director_activity");
  assert.equal(auditInserts.length, 1, "exactly one audit row per run");
  const row = auditInserts[0]!.row!;
  assert.equal(row.director_function, "growth");
  assert.equal(row.action_kind, "angle_demand_sweep_ran");
  assert.equal(row.workspace_id, "ws-1");
  const meta = row.metadata as Record<string, unknown>;
  assert.equal(meta.product_id, "prod-1");
  assert.equal(meta.rows_refreshed, summary.rowsRefreshed);
  assert.equal(meta.drafts_created, summary.draftsCreated);
  assert.equal(meta.provider, summary.provider);
  assert.equal(meta.provider, "test-provider");
  assert.equal(meta.autonomous, true);
  assert.deepEqual(meta.ingredients, ["collagen", "matcha"]);
  resetSearchDemandProvider();
});

test("runSweepForProduct: EVERY palette write flows through the angle-palette SDK path (never a raw .from('product_angle_palette').insert/delete)", async () => {
  const highProvider: SearchDemandProvider = async () => ({ tier: "high", rawVolume: 4200, source: "test-provider" });
  setSearchDemandProvider(highProvider);
  const { admin, writes } = makeSweepAdmin({ existingPaletteRows: [] });
  await runSweepForProduct({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    ingredientNames: ["collagen"],
  });
  // The SDK exclusively uses upsert (for new drafts) and update (for refresh); no insert/delete.
  const paletteWrites = writes.filter((w) => w.table === "product_angle_palette");
  assert.ok(paletteWrites.length > 0);
  for (const w of paletteWrites) {
    assert.ok(w.op === "upsert" || w.op === "update", `palette writes go through SDK ops only; saw ${w.op}`);
  }
  // upsertAngle uses the SDK's on-conflict key — this proves the write actually flowed through it.
  const upserts = paletteWrites.filter((w) => w.op === "upsert");
  for (const u of upserts) {
    assert.equal(u.onConflict, "workspace_id,product_id,theme,problem");
  }
  resetSearchDemandProvider();
});

test("PROBLEM_LANES enumeration is a non-empty, deduplicated (theme, problem) table (auditable, not a runtime cross-product)", () => {
  assert.ok(PROBLEM_LANES.length > 0);
  const seen = new Set<string>();
  for (const lane of PROBLEM_LANES) {
    const key = `${lane.theme}::${lane.problem}`;
    assert.ok(!seen.has(key), `duplicate lane in PROBLEM_LANES: ${key}`);
    seen.add(key);
    // Themes are constrained to the AngleTheme union — a bad theme would break upsertAngle.
    assert.match(lane.theme, /^(beauty|longevity|healthy_weight|energy_performance|focus|gut)$/);
    assert.ok(lane.problem.length > 0);
  }
});
