/**
 * Anchor the init_loop_guard dedupe lookback to the build failure time
 * (spec: mario-init-loop-guard-dedupe-anchor-lookback-to-failure-time Phase 1).
 *
 * The old code derived the escalation-read floor from `now - 7d`; once a human parked
 * a failed build longer than a week, the covering `init_loop_guard` escalation aged
 * out of the window, the dedupe stopped seeing it, and Mario re-fired on a spec the
 * CEO already owned (close-snapshot-coverage-guard: ~3.5 min outside the window).
 *
 * The floor is now the earliest aged failed_at minus a 60s epsilon, so a covering
 * escalation is always in range regardless of how old the failure is. These tests
 * pin the exact behavior:
 *   (a) aged >7d + covering escalation landed just after failure   → DROPPED
 *   (b) aged >7d + NO escalation                                   → KEPT
 *   (c) aged >7d + escalation superseded by later escorted_init    → KEPT
 *
 * The queries hit `agent_jobs`, `director_activity`, and `spec_timecard_events`;
 * a minimal chainable Supabase-shaped stub records the ISO `gte()` floor + returns
 * canned rows so we assert both the anchor-time predicate AND the downstream
 * keep/supersede logic in one test.
 *
 *   Run:    npx tsx --test src/lib/mario.failed-build-escalation-anchor.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFailedBuildStalls } from "./mario";
import type { SupabaseClient } from "@supabase/supabase-js";

interface Row {
  [k: string]: unknown;
}

/**
 * A tiny chainable Supabase-shaped stub — every filter method just records itself
 * onto the pending query and returns `this`; the terminal `.limit()` is thenable
 * so `await …limit(N)` resolves to `{ data, error }`.
 *
 * The `route(table)` callback lets each test supply table-specific rows AND observe
 * the exact filter args (crucially: the `gte('created_at', sinceIso)` floor).
 */
function makeAdmin(
  route: (table: string, calls: Array<[string, ...unknown[]]>) => Row[],
): { admin: SupabaseClient; callsByTable: Record<string, Array<Array<[string, ...unknown[]]>>> } {
  const callsByTable: Record<string, Array<Array<[string, ...unknown[]]>>> = {};
  const admin = {
    from(table: string) {
      const chain: Array<[string, ...unknown[]]> = [];
      (callsByTable[table] ??= []).push(chain);
      const builder: Record<string, unknown> = {};
      const passthrough = ["select", "eq", "in", "gte", "order", "or", "neq"] as const;
      for (const m of passthrough) {
        builder[m] = (...args: unknown[]) => {
          chain.push([m, ...args]);
          return builder;
        };
      }
      builder.limit = (n: number) => {
        chain.push(["limit", n]);
        const data = route(table, chain);
        return Promise.resolve({ data, error: null });
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { admin, callsByTable };
}

const WS = "ws_test";
const GRACE_MS = 20 * 60 * 1000;

const now = Date.parse("2026-09-15T12:00:00.000Z");
// A failed build that is 30 days old — well past the old 7d window.
const OLD_FAILED_AT = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
// Its covering escalation landed one minute AFTER the build failed. Both are now ~30d old,
// so with the OLD now-minus-7d floor the escalation would be excluded from the read.
const OLD_ESC_AT = new Date(Date.parse(OLD_FAILED_AT) + 60_000).toISOString();

test("(a) aged >7d, covering init_loop_guard escalation landed after failure → DROPPED (dedupe survives escalation age)", async () => {
  const slug = "close-snapshot-coverage-guard";
  const { admin, callsByTable } = makeAdmin((table, chain) => {
    if (table === "agent_jobs") {
      return [{ spec_slug: slug, status: "failed", updated_at: OLD_FAILED_AT }];
    }
    if (table === "director_activity") {
      // The dropSet gets populated by the escalated read, which then triggers a follow-up
      // escorted_init read on the same table — return [] there so no supersede.
      const isEscalated = chain.some(
        ([m, k, v]) => m === "eq" && k === "action_kind" && v === "escalated",
      );
      if (isEscalated) return [{ spec_slug: slug, created_at: OLD_ESC_AT }];
      return [];
    }
    if (table === "spec_timecard_events") return [];
    return [];
  });

  const out = await readFailedBuildStalls(admin, WS, GRACE_MS);
  assert.deepEqual(out, [], "the failed build must be dropped — its escalation covers it");

  // Prove the anchor: the escalation read's gte floor is derived from OLD_FAILED_AT, NOT from now-7d.
  // Find the specific director_activity chain that ran the escalated read.
  const escChain = (callsByTable["director_activity"] ?? []).find((c) =>
    c.some(([m, k, v]) => m === "eq" && k === "action_kind" && v === "escalated"),
  );
  assert.ok(escChain, "an escalated read must have been issued against director_activity");
  const gte = escChain!.find(([m]) => m === "gte");
  assert.ok(gte, "escalation read must set a created_at floor");
  const floorIso = String(gte![2]);
  const floorMs = Date.parse(floorIso);
  // Floor sits at earliest failed_at - 60_000ms (± ms). Anything close to `now - 7d` is a regression.
  assert.equal(floorMs, Date.parse(OLD_FAILED_AT) - 60_000, "floor must be earliest failed_at - 60s epsilon");
  // Anchor sanity: the escalation timestamp IS above the floor (otherwise the dedupe couldn't have seen it).
  assert.ok(Date.parse(OLD_ESC_AT) >= floorMs, "escalation must be in range of the anchored floor");
});

test("(b) aged >7d, NO escalation → KEPT (a genuinely orphaned failure still surfaces)", async () => {
  const slug = "no-covering-escalation-slug";
  const { admin } = makeAdmin((table) => {
    if (table === "agent_jobs") {
      return [{ spec_slug: slug, status: "failed", updated_at: OLD_FAILED_AT }];
    }
    if (table === "director_activity") return []; // no escalation, no supersede
    if (table === "spec_timecard_events") return [];
    return [];
  });

  const out = await readFailedBuildStalls(admin, WS, GRACE_MS);
  assert.equal(out.length, 1);
  assert.equal(out[0].spec_slug, slug);
  assert.equal(out[0].workspace_id, WS);
});

test("(c) escalation superseded by later escorted_init → KEPT (the human resolved it and a new build was driven)", async () => {
  const slug = "escalation-superseded-slug";
  // escorted_init landed AFTER the escalation → supersedes it → the failed build resurfaces.
  const ESCORTED_AT = new Date(Date.parse(OLD_ESC_AT) + 24 * 60 * 60 * 1000).toISOString();

  const { admin } = makeAdmin((table, chain) => {
    if (table === "agent_jobs") {
      return [{ spec_slug: slug, status: "failed", updated_at: OLD_FAILED_AT }];
    }
    if (table === "director_activity") {
      const isEscalated = chain.some(
        ([m, k, v]) => m === "eq" && k === "action_kind" && v === "escalated",
      );
      const isEscorted = chain.some(
        ([m, k, v]) => m === "eq" && k === "action_kind" && v === "escorted_init",
      );
      if (isEscalated) return [{ spec_slug: slug, created_at: OLD_ESC_AT }];
      if (isEscorted) return [{ spec_slug: slug, created_at: ESCORTED_AT }];
      return [];
    }
    if (table === "spec_timecard_events") return []; // no build_done supersede path here
    return [];
  });

  const out = await readFailedBuildStalls(admin, WS, GRACE_MS);
  assert.equal(out.length, 1, "escorted_init after escalation resolves the dedupe → resurface");
  assert.equal(out[0].spec_slug, slug);
});
