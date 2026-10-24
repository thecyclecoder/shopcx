/**
 * Unit tests for the CROSS-SOURCE init_loop_guard ownership helper
 * (spec: mario-timecard-source-bypasses-init-loop-guard-dedupe Phase 1).
 *
 * The bug: a failed build always emits `build_started` but never `build_done`, so
 * `evaluateStalledSpecs`' primary timecard source (step (a)) always matches a failed build under
 * the build_started→build_done threshold and claims the dedupe `seen` key BEFORE the (a2)
 * failed-build source runs. Because the init_loop_guard dedupe used to live INSIDE
 * `readFailedBuildStalls`, it was bypassed for every failed+init_loop_guard-escalated build — Mario
 * fired on a spec a human already owned (build 6eb22d37: failed 15:34:05, escalated 15:36:59, fired
 * anyway, every tick, forever).
 *
 * The fix lifts the ownership decision into the exported `readInitLoopGuardOwnedSlugs` helper, which
 * `evaluateStalledSpecs` applies as a cross-source drop. These tests pin the helper's exact decision:
 *   (a) latest build failed + covering init_loop_guard escalation after it   → OWNED (dropped)
 *   (b) latest build failed + NO escalation                                   → NOT owned (surfaces)
 *   (c) escalation superseded by a later escorted_init                        → NOT owned (surfaces)
 *   (d) latest build NOT failed (succeeded)                                   → NOT owned
 *   (e) director_activity escalation read errors                              → FAIL-OPEN (empty set)
 *
 *   Run:  npx tsx --test src/lib/mario.init-loop-guard-owned-slugs.test.ts
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
const now = Date.parse("2026-10-24T12:00:00.000Z");
const FAILED_AT = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
const ESC_AFTER = new Date(Date.parse(FAILED_AT) + 3 * 60 * 1000).toISOString(); // escalation 3m after failure

function isEscalated(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(([m, k, v]) => m === "eq" && k === "action_kind" && v === "escalated");
}
function isEscorted(chain: Array<[string, ...unknown[]]>): boolean {
  return chain.some(([m, k, v]) => m === "eq" && k === "action_kind" && v === "escorted_init");
}

test("(a) failed build + covering init_loop_guard escalation → OWNED (so it is dropped across sources)", async () => {
  const slug = "init-loop-guard-held-slug";
  const admin = makeAdmin((table, chain) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") {
      if (isEscalated(chain)) return { data: [{ spec_slug: slug, created_at: ESC_AFTER }], error: null };
      return { data: [], error: null }; // escorted_init → none
    }
    if (table === "spec_timecard_events") return { data: [], error: null }; // no build_done
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.ok(owned.has(slug), "a failed build whose init_loop_guard escalation covers it is human-owned");
});

test("(b) failed build + NO escalation → NOT owned (a genuinely orphaned failure still surfaces)", async () => {
  const slug = "orphaned-failure-slug";
  const admin = makeAdmin((table) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.equal(owned.has(slug), false);
});

test("(c) escalation superseded by a later escorted_init → NOT owned (human resolved it, new build driven)", async () => {
  const slug = "superseded-slug";
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

test("(d) latest build succeeded → NOT owned (ownership only applies to a CURRENT failure)", async () => {
  const slug = "succeeded-slug";
  const admin = makeAdmin((table) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "completed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") return { data: [{ spec_slug: slug, created_at: ESC_AFTER }], error: null };
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.equal(owned.has(slug), false);
});

test("(e) director_activity escalation read error → FAIL-OPEN (empty set, so the candidate is KEPT)", async () => {
  const slug = "read-error-slug";
  const admin = makeAdmin((table) => {
    if (table === "agent_jobs") return { data: [{ spec_slug: slug, status: "failed", updated_at: FAILED_AT }], error: null };
    if (table === "director_activity") return { data: null, error: { message: "boom" } };
    return { data: [], error: null };
  });
  const owned = await readInitLoopGuardOwnedSlugs(admin, WS);
  assert.equal(owned.size, 0, "a read error must fail OPEN — drop nothing");
});
