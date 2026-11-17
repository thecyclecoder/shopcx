/**
 * Unit tests for the GOAL-ESCORT loop_guard coverage of the cross-source ownership helper
 * (spec: mario-drop-goal-escort-loop-guard-owned-specs Phase 1).
 *
 * The bug: readInitLoopGuardOwnedSlugs only matched escalation_kind='init_loop_guard', but a
 * GOAL-ESCORTED spec whose build fails the loop-guard escalates under a DIFFERENT kind — 'loop_guard'
 * (dedupe_key 'loopguard:<slug>'). That escalation was NOT matched, so the ownership drop was bypassed
 * and Mario fired every 5-min tick forever on a spec a human already owned (next-order-journey-editor:
 * build failed 2026-11-17T19:02:31, loop_guard escalated 19:03:45, Mario enqueued anyway 19:25:06).
 *
 * The fix broadens the escalation filter to .in(['init_loop_guard','loop_guard']) and the supersede
 * re-confirm's escorted lookup to .in(['escorted_init','escorted_goal']) — so a goal-escort loop_guard
 * escalation drops the candidate exactly like an init_loop_guard one until a later escorted_goal /
 * escorted_init or build_done un-owns it. These tests pin the goal-escort decision:
 *   (a) latest build failed + covering loop_guard escalation after it     → OWNED (dropped)
 *   (b) escalation superseded by a later escorted_goal                     → NOT owned (surfaces)
 *   (c) escalation superseded by a later build_done                       → NOT owned (surfaces)
 *
 *   Run:  npx tsx --test src/lib/mario.goal-escort-loop-guard-owned-slugs.test.ts
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
const now = Date.parse("2026-11-17T20:00:00.000Z");
const FAILED_AT = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
const ESC_AFTER = new Date(Date.parse(FAILED_AT) + 3 * 60 * 1000).toISOString(); // escalation 3m after failure

/** The escalation query is the one scoped to action_kind='escalated'. */
function isEscalated(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(([m, k, v]) => m === "eq" && k === "action_kind" && v === "escalated");
}
/**
 * True only when the escalation_kind filter COVERS 'loop_guard' — i.e. the fix shipped.
 * Unmodified code uses `.eq('metadata->>escalation_kind','init_loop_guard')` (does NOT cover
 * loop_guard); the fix uses `.in('metadata->>escalation_kind', ['init_loop_guard','loop_guard'])`.
 */
function coversLoopGuard(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(
    ([m, k, v]) =>
      m === "in" &&
      k === "metadata->>escalation_kind" &&
      Array.isArray(v) &&
      (v as unknown[]).includes("loop_guard"),
  );
}
/** The supersede re-confirm now matches both escorted kinds via `.in('action_kind', [...])`. */
function isEscorted(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(
    ([m, k, v]) =>
      m === "in" &&
      k === "action_kind" &&
      Array.isArray(v) &&
      (v as unknown[]).includes("escorted_goal"),
  );
}

test("(a) failed build + covering goal-escort loop_guard escalation → OWNED (dropped across sources)", async () => {
  const slug = "next-order-journey-editor";
  const admin = makeAdmin((table, chain) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") {
      // The loop_guard escalation row is returned ONLY when the query's escalation_kind filter
      // covers 'loop_guard' — so this test fails on unmodified code and passes after the fix.
      if (isEscalated(chain)) return { data: coversLoopGuard(chain) ? [{ spec_slug: slug, created_at: ESC_AFTER }] : [], error: null };
      return { data: [], error: null }; // escorted_* → none
    }
    if (table === "spec_timecard_events") return { data: [], error: null }; // no build_done
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.ok(owned.has(slug), "a failed build whose goal-escort loop_guard escalation covers it is human-owned");
});

test("(b) escalation superseded by a later escorted_goal → NOT owned (human re-drove the goal-escort)", async () => {
  const slug = "goal-escort-superseded-slug";
  const ESCORTED_AFTER = new Date(Date.parse(ESC_AFTER) + 10 * 60 * 1000).toISOString();
  const admin = makeAdmin((table, chain) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") {
      if (isEscalated(chain)) return { data: [{ spec_slug: slug, created_at: ESC_AFTER }], error: null };
      if (isEscorted(chain)) return { data: [{ spec_slug: slug, created_at: ESCORTED_AFTER }], error: null };
      return { data: [], error: null };
    }
    if (table === "spec_timecard_events") return { data: [], error: null };
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.equal(owned.has(slug), false);
});

test("(c) escalation superseded by a later build_done → NOT owned (a new build was driven)", async () => {
  const slug = "goal-escort-rebuilt-slug";
  const DONE_AFTER = new Date(Date.parse(ESC_AFTER) + 10 * 60 * 1000).toISOString();
  const admin = makeAdmin((table, chain) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") {
      if (isEscalated(chain)) return { data: [{ spec_slug: slug, created_at: ESC_AFTER }], error: null };
      return { data: [], error: null };
    }
    if (table === "spec_timecard_events") return { data: [{ spec_slug: slug, at: DONE_AFTER }], error: null };
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.equal(owned.has(slug), false);
});
