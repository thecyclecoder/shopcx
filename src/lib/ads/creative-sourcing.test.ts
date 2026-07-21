/**
 * creative-sourcing tests — pin the dahlia-deeper-competitor-selection Phase 1 invariants
 * (see docs/brain/specs/dahlia-deeper-competitor-selection.md):
 *
 *   1. `preferDeeplyProven:true` raises the pool floor to 60d AND filters
 *      `resume_advertising=true`. A shallow 30d row with resume=false is excluded.
 *   2. An EMPTY deeply-proven pool falls back to the shallow 30d/no-resume pool AND
 *      returns `usedFallback:true` AND emits ONE `director_activity` row with
 *      `action_kind='dahlia_deeply_proven_fallback'` (visible, never silent).
 *   3. The default (no `preferDeeplyProven`) call is byte-identical to the legacy
 *      shape — 30d floor, no resume_advertising filter — so the two non-Dahlia
 *      callers (ads-supervisor Dahlia-seeding finding, workspace-wide angle reads)
 *      are unchanged.
 *
 * Pure helper — no network, no live DB. Runs via:
 *   npx tsx --test src/lib/ads/creative-sourcing.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getProvenCompetitorAngles } from "./creative-sourcing";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const WS = "00000000-0000-0000-0000-0000000000ws";
const PRODUCT = "prod-cofee-deep";

interface SkeletonRow {
  workspace_id: string;
  product_id: string | null;
  status: string;
  advertiser: string | null;
  hook: string | null;
  framework: string | null;
  mechanism_claim: string | null;
  proof: string | null;
  offer: string | null;
  days_running: number | null;
  heat: number | null;
  destination_domain: string | null;
  image_url: string | null;
  resume_advertising: boolean | null;
  // Dahlia imitates STATIC competitor ads only (#2020) — getProvenCompetitorAngles filters
  // `.eq("media_type","static")`, so the fixtures must carry it or every row is (correctly) dropped.
  media_type: string | null;
  // flag-a-competitor-ad-do-not-use Phase 1 — queryProvenAngles filters `.eq("do_not_use", false)`,
  // so a fixture MUST carry the flag or it's excluded from the shelf.
  do_not_use: boolean | null;
}

interface ActivityRow {
  workspace_id: string;
  director_function: string;
  action_kind: string;
  spec_slug: string | null;
  reason: string;
  metadata: Record<string, unknown>;
}

interface Seed {
  skeletons: SkeletonRow[];
}

function skel(over: Partial<SkeletonRow>): SkeletonRow {
  return {
    workspace_id: WS,
    product_id: PRODUCT,
    status: "analyzed",
    advertiser: "Rival Co",
    hook: "Meet Nature's Ozempic",
    framework: "hook-mech-offer",
    mechanism_claim: "coffee that curbs cravings",
    proof: "10k+ served",
    offer: "20% off",
    days_running: 90,
    heat: 4,
    destination_domain: "rivalco.com",
    image_url: "https://cdn.example/x.jpg",
    resume_advertising: true,
    media_type: "static",
    do_not_use: false,
    ...over,
  };
}

function makeAdmin(seed: Seed): { admin: Admin; activity: ActivityRow[] } {
  const activity: ActivityRow[] = [];

  function fromCreativeSkeletons() {
    const filters: Record<string, unknown> = {};
    const notNull: string[] = [];
    let gteDays: number | null = null;
    let limitN: number | null = null;
    const builder: Record<string, unknown> = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      not(col: string, _op: string, _val: unknown) {
        notNull.push(col);
        return builder;
      },
      gte(col: string, val: number) {
        if (col === "days_running") gteDays = val;
        return builder;
      },
      or(_expr: string) {
        return builder;
      },
      order(_col: string, _opts: unknown) {
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      then(resolve: (v: unknown) => void) {
        const rows = seed.skeletons.filter((r) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          for (const col of notNull) {
            if ((r as unknown as Record<string, unknown>)[col] == null) return false;
          }
          if (gteDays != null && (r.days_running ?? -1) < gteDays) return false;
          return true;
        });
        const ordered = [...rows].sort((a, b) => (b.days_running ?? 0) - (a.days_running ?? 0));
        const capped = limitN != null ? ordered.slice(0, limitN) : ordered;
        resolve({ data: capped, error: null });
      },
    };
    return builder;
  }

  function fromDirectorActivity() {
    const builder: Record<string, unknown> = {
      insert(row: Record<string, unknown>) {
        activity.push({
          workspace_id: String(row.workspace_id),
          director_function: String(row.director_function),
          action_kind: String(row.action_kind),
          spec_slug: (row.spec_slug as string | null) ?? null,
          reason: String(row.reason ?? ""),
          metadata: (row.metadata as Record<string, unknown>) ?? {},
        });
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "creative_skeletons") return fromCreativeSkeletons();
      if (table === "director_activity") return fromDirectorActivity();
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as Admin;

  return { admin, activity };
}

test("getProvenCompetitorAngles: preferDeeplyProven raises the floor to 60d AND filters resume_advertising=true", async () => {
  const { admin, activity } = makeAdmin({
    skeletons: [
      // deeply-proven — kept
      skel({ hook: "60d deep", days_running: 62, resume_advertising: true }),
      skel({ hook: "90d deep", days_running: 90, resume_advertising: true }),
      // 30d + still running — SHALLOW, excluded by the deep floor
      skel({ hook: "30d still running", days_running: 33, resume_advertising: true }),
      // 60d+ but PAUSED — excluded by the resume_advertising filter
      skel({ hook: "60d paused", days_running: 80, resume_advertising: false }),
      // 90d+ still-running but a VIDEO — excluded by the static-only filter (#2020). Dahlia only
      // imitates static image ads right now; a processed video shelf row must never be an imitate base.
      skel({ hook: "90d video", days_running: 95, resume_advertising: true, media_type: "video" }),
    ],
  });
  const { angles, usedFallback } = await getProvenCompetitorAngles(admin, WS, {
    productId: PRODUCT,
    preferDeeplyProven: true,
    limit: 10,
  });
  assert.equal(usedFallback, false, "deeply-proven pool has rows → NOT a fallback");
  const hooks = angles.map((a) => a.hook);
  assert.ok(hooks.includes("60d deep"), "60d+ still-running row was kept");
  assert.ok(hooks.includes("90d deep"), "90d+ still-running row was kept");
  assert.ok(!hooks.includes("30d still running"), "shallow 30d row is excluded by the deep floor");
  assert.ok(!hooks.includes("60d paused"), "60d+ but paused row is excluded by resume_advertising filter");
  assert.ok(!hooks.includes("90d video"), "video row is excluded by the static-only filter (#2020)");
  assert.equal(activity.length, 0, "no fallback → NO director_activity row emitted");
});

test("getProvenCompetitorAngles: EMPTY deeply-proven pool falls back to shallow AND emits a director_activity row (visible fallback)", async () => {
  const { admin, activity } = makeAdmin({
    skeletons: [
      // NO 60d+ still-running rows for this product — force a fallback
      skel({ hook: "35d shallow A", days_running: 35, resume_advertising: false }),
      skel({ hook: "45d shallow B", days_running: 45, resume_advertising: null }),
    ],
  });
  const { angles, usedFallback } = await getProvenCompetitorAngles(admin, WS, {
    productId: PRODUCT,
    preferDeeplyProven: true,
    limit: 10,
  });
  assert.equal(usedFallback, true, "empty deeply-proven pool → usedFallback:true");
  assert.equal(angles.length, 2, "fallback returned the shallow 30d/no-resume pool");
  const hooks = angles.map((a) => a.hook);
  assert.ok(hooks.includes("35d shallow A"));
  assert.ok(hooks.includes("45d shallow B"));

  // The fallback must be VISIBLE — a director_activity row with the audit vocabulary the
  // spec pins (never a silent flip).
  assert.equal(activity.length, 1, "exactly one director_activity row was emitted");
  const row = activity[0];
  assert.equal(row.action_kind, "dahlia_deeply_proven_fallback");
  assert.equal(row.director_function, "growth");
  assert.equal(row.spec_slug, "dahlia-deeper-competitor-selection");
  assert.equal(row.workspace_id, WS);
  assert.equal(row.metadata.product_id, PRODUCT);
  assert.equal(row.metadata.deeply_proven_min_days, 60);
  assert.equal(row.metadata.fallback_min_days, 30);
  assert.equal(row.metadata.fallback_pool_size, 2);
  assert.equal(row.metadata.autonomous, true);
});

test("getProvenCompetitorAngles: default (no preferDeeplyProven) is UNCHANGED — 30d floor, no resume_advertising filter, no audit row", async () => {
  const { admin, activity } = makeAdmin({
    skeletons: [
      skel({ hook: "30d still running", days_running: 33, resume_advertising: true }),
      skel({ hook: "45d paused", days_running: 45, resume_advertising: false }),
      // Below the shallow 30d floor — excluded
      skel({ hook: "10d too new", days_running: 10, resume_advertising: true }),
    ],
  });
  const { angles, usedFallback } = await getProvenCompetitorAngles(admin, WS, {
    productId: PRODUCT,
    limit: 10,
  });
  assert.equal(usedFallback, false, "no preferDeeplyProven → never a fallback");
  const hooks = angles.map((a) => a.hook);
  assert.ok(hooks.includes("30d still running"));
  assert.ok(hooks.includes("45d paused"), "legacy path DOES NOT filter resume_advertising");
  assert.ok(!hooks.includes("10d too new"), "still floored at 30d by default");
  assert.equal(activity.length, 0, "no fallback path taken → no director_activity row");
});
