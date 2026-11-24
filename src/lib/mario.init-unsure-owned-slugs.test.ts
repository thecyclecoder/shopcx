/**
 * Unit tests for the init_unsure (CEO greenlight hold) coverage of the cross-source ownership helper
 * (spec: mario-owned-slug-filter-covers-init-unsure-ceo-escalations Phase 2).
 *
 * The bug: readInitLoopGuardOwnedSlugs only matched escalation_kind IN ('init_loop_guard','loop_guard'),
 * but the platform init lane holds an ambiguous/out-of-scope/new-goal spec for a CEO call under a
 * DIFFERENT kind — 'init_unsure' (and its sibling 'init_dismiss_rework'), both dedupe_key
 * 'init-unsure:<slug>' ('Initiation needs a call … Holding off — your call', scripts/builder-worker.ts).
 * That escalation was NOT matched, so the ownership drop was bypassed and Mario fired every 5-min tick
 * forever on a spec the CEO already owned (ai-shopping-agent-mcp: build failed 2026-11-23T23:41:36,
 * init_unsure escalated 23:48:15, Mario re-fired every tick — build_done never arrives on a failed build).
 *
 * The fix broadens the escalation filter to
 * .in(['init_loop_guard','loop_guard','init_unsure','init_dismiss_rework']); the newer-than-failure
 * anchor and the escorted_init/escorted_goal/build_done supersede re-check already generalize. These
 * tests pin the init_unsure decision, mirroring the goal-escort loop_guard test:
 *   (a) latest build failed + covering init_unsure escalation after it  → OWNED (dropped)
 *   (b) escalation superseded by a later escorted_init                  → NOT owned (surfaces)
 *
 *   Run:  npx tsx --test src/lib/mario.init-unsure-owned-slugs.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readInitLoopGuardOwnedSlugs } from "./mario";
import type { SupabaseClient } from "@supabase/supabase-js";

interface Row {
  [k: string]: unknown;
}

/** Chainable Supabase-shaped stub — each terminal `.limit()` resolves `{ data, error }` from `route`. */
function makeAdmin(
  route: (table: string, calls: Array<[string, ...unknown[]]>) => { data: Row[] | null; error: unknown },
): SupabaseClient {
  return {
    from(table: string) {
      const chain: Array<[string, ...unknown[]]> = [];
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "or", "neq"] as const) {
        builder[m] = (...args: unknown[]) => {
          chain.push([m, ...args]);
          return builder;
        };
      }
      builder.limit = (n: number) => {
        chain.push(["limit", n]);
        return Promise.resolve(route(table, chain));
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const WS = "ws_test";
const now = Date.parse("2026-11-24T00:00:00.000Z");
const FAILED_AT = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
const ESC_AFTER = new Date(Date.parse(FAILED_AT) + 3 * 60 * 1000).toISOString(); // escalation 3m after failure

/** The escalation query is the one scoped to action_kind='escalated'. */
function isEscalated(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(([m, k, v]) => m === "eq" && k === "action_kind" && v === "escalated");
}
/**
 * True only when the escalation_kind filter COVERS 'init_unsure' — i.e. the fix shipped.
 * Pre-fix code used `.in('metadata->>escalation_kind', ['init_loop_guard','loop_guard'])` (does NOT
 * cover init_unsure); the fix adds 'init_unsure' + 'init_dismiss_rework' to that IN-list.
 */
function coversInitUnsure(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(
    ([m, k, v]) =>
      m === "in" &&
      k === "metadata->>escalation_kind" &&
      Array.isArray(v) &&
      (v as unknown[]).includes("init_unsure"),
  );
}
/** The supersede re-confirm matches both escorted kinds via `.in('action_kind', [...])`. */
function isEscorted(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(
    ([m, k, v]) =>
      m === "in" &&
      k === "action_kind" &&
      Array.isArray(v) &&
      (v as unknown[]).includes("escorted_init"),
  );
}

test("(a) failed build + covering init_unsure CEO escalation → OWNED (dropped across sources)", async () => {
  const slug = "ai-shopping-agent-mcp";
  const admin = makeAdmin((table, chain) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") {
      // The init_unsure escalation row is returned ONLY when the query's escalation_kind filter
      // covers 'init_unsure' — so this test fails on pre-fix code and passes after the fix.
      if (isEscalated(chain)) return { data: coversInitUnsure(chain) ? [{ spec_slug: slug, created_at: ESC_AFTER }] : [], error: null };
      return { data: [], error: null }; // escorted_* → none
    }
    if (table === "spec_timecard_events") return { data: [], error: null }; // no build_done
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.ok(owned.has(slug), "a failed build whose init_unsure CEO escalation covers it is human-owned");
});

test("(b) escalation superseded by a later escorted_init → NOT owned (CEO greenlit, re-drove the build)", async () => {
  const slug = "init-unsure-superseded-slug";
  const ESCORTED_AFTER = new Date(Date.parse(ESC_AFTER) + 5 * 60 * 1000).toISOString(); // escorted 5m after escalation
  const admin = makeAdmin((table, chain) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") {
      if (isEscalated(chain)) return { data: coversInitUnsure(chain) ? [{ spec_slug: slug, created_at: ESC_AFTER }] : [], error: null };
      if (isEscorted(chain)) return { data: [{ spec_slug: slug, created_at: ESCORTED_AFTER }], error: null };
      return { data: [], error: null };
    }
    if (table === "spec_timecard_events") return { data: [], error: null };
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.equal(owned.has(slug), false);
});
