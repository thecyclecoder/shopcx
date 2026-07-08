/**
 * Unit tests for the cap-hit `early_warning` storyline composed into
 * `cs_director_digests` — Fix 1 of docs/brain/specs/sol-runaway-re-session-cap-guardrail.md.
 *
 * We exercise `composeCsDirectorDigest` against an in-memory Supabase stub covering the
 * four tables the composer reads (director_activity, ticket_resolution_events,
 * ai_channel_config, cs_director_digests). Verification bullets:
 *   - 6 cap-hits in the window + threshold=5 (default) → ONE early_warning storyline is
 *     inserted with `kind='early_warning'` + title containing "Sol re-session cap hit"
 *     + `proposed_action.type='add_policy'`.
 *   - 5 cap-hits + threshold=5 → NO cap-hit storyline (strict `>`).
 *   - Threshold read is the MAX across channels; a workspace with `[5, 10]` needs 11 to fire.
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/cs-director-digest.capHits.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeCsDirectorDigest } from "./cs-director-digest";

const WS = "00000000-0000-0000-0000-0000000000ws";
const SINCE = "2026-07-01T00:00:00Z";
const UNTIL = "2026-07-08T00:00:00Z";

function makeAdmin(seed: {
  cap_hit_rows: Array<{
    workspace_id?: string;
    ticket_id: string;
    reasoning: string;
    staged_at: string;
    problem?: string | null;
    verified_outcome?: string | null;
    chosen?: Record<string, unknown> | null;
  }>;
  ai_channel_config: Array<{ workspace_id: string; sol_cap_hit_alarm: number | null }>;
  existing_digests?: Array<{ workspace_id: string; digest_period_start: string }>;
}) {
  const state = {
    inserted_digests: [] as Array<{
      workspace_id: string;
      digest_period_start: string;
      digest_period_end: string;
      storylines: unknown[];
    }>,
  };

  function fromResolutionEvents() {
    const filters: Record<string, unknown> = {};
    const gte: Record<string, string> = {};
    const lt: Record<string, string> = {};
    let notNullCol: string | null = null;
    let limitN: number | null = null;
    const builder: Record<string, unknown> = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      gte(col: string, val: string) {
        gte[col] = val;
        return builder;
      },
      lt(col: string, val: string) {
        lt[col] = val;
        return builder;
      },
      not(col: string, _op: string, _val: unknown) {
        notNullCol = col;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      then(resolve: (v: unknown) => void) {
        const rows = seed.cap_hit_rows.filter((r) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          for (const [k, v] of Object.entries(gte)) {
            if (String((r as unknown as Record<string, unknown>)[k]) < v) return false;
          }
          for (const [k, v] of Object.entries(lt)) {
            if (String((r as unknown as Record<string, unknown>)[k]) >= v) return false;
          }
          if (notNullCol && (r as unknown as Record<string, unknown>)[notNullCol] === null) {
            return false;
          }
          return true;
        });
        const capped = limitN !== null ? rows.slice(0, limitN) : rows;
        resolve({ data: capped, error: null });
      },
    };
    return builder;
  }

  function fromDirectorActivity() {
    const builder: Record<string, unknown> = {
      select(_cols: string) {
        return builder;
      },
      eq(_col: string, _val: unknown) {
        return builder;
      },
      gte(_col: string, _val: string) {
        return builder;
      },
      lt(_col: string, _val: string) {
        return builder;
      },
      order(_col: string, _opts: unknown) {
        return Promise.resolve({ data: [], error: null });
      },
    };
    return builder;
  }

  function fromAiChannelConfig() {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      then(resolve: (v: unknown) => void) {
        const rows = seed.ai_channel_config.filter((r) => {
          for (const [k, v] of Object.entries(filters)) {
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  function fromCsDirectorDigests() {
    let inserted: {
      workspace_id: string;
      digest_period_start: string;
      digest_period_end: string;
      storylines: unknown[];
    } | null = null;
    const filters: Record<string, unknown> = {};
    let limitN: number | null = null;
    const builder: Record<string, unknown> = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return Promise.resolve({
          data: (seed.existing_digests ?? []).filter((d) => {
            for (const [k, v] of Object.entries(filters)) {
              if ((d as unknown as Record<string, unknown>)[k] !== v) return false;
            }
            return true;
          }).slice(0, limitN ?? 1),
          error: null,
        });
      },
      insert(row: Record<string, unknown>) {
        inserted = {
          workspace_id: String(row.workspace_id),
          digest_period_start: String(row.digest_period_start),
          digest_period_end: String(row.digest_period_end),
          storylines: (row.storylines as unknown[]) ?? [],
        };
        state.inserted_digests.push(inserted);
        return {
          select(_cols: string) {
            return {
              single() {
                return Promise.resolve({
                  data: {
                    id: "digest-id",
                    ...inserted,
                    created_at: "2026-07-08T00:00:00Z",
                  },
                  error: null,
                });
              },
            };
          },
        };
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "ticket_resolution_events") return fromResolutionEvents();
      if (table === "director_activity") return fromDirectorActivity();
      if (table === "ai_channel_config") return fromAiChannelConfig();
      if (table === "cs_director_digests") return fromCsDirectorDigests();
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { admin: admin as unknown as ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>, state };
}

function makeCapHitRow(i: number, kind: "frustration" | "drift"): {
  workspace_id: string;
  ticket_id: string;
  reasoning: string;
  staged_at: string;
  problem: null;
  verified_outcome: null;
  chosen: { kind: string };
} {
  return {
    workspace_id: WS,
    ticket_id: `tkt-${i}`,
    reasoning: "sol:cap-hit",
    staged_at: `2026-07-0${(i % 7) + 1}T00:00:00Z`,
    problem: null,
    verified_outcome: null,
    chosen: { kind },
  };
}

test("6 cap-hits + threshold=5 (default) → ONE early_warning storyline titled 'Sol re-session cap hit'", async () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => makeCapHitRow(i, "frustration")),
    ...Array.from({ length: 2 }, (_, i) => makeCapHitRow(i + 4, "drift")),
  ];
  const { admin, state } = makeAdmin({
    cap_hit_rows: rows,
    ai_channel_config: [{ workspace_id: WS, sol_cap_hit_alarm: 5 }],
  });
  const { inserted, storylineCount } = await composeCsDirectorDigest(admin, WS, SINCE, UNTIL);
  assert.equal(inserted, true);
  assert.ok(storylineCount >= 1, "at least one storyline for the cap-hit escalation");
  const digest = state.inserted_digests[0]!;
  const capHitStoryline = (digest.storylines as Array<Record<string, unknown>>).find(
    (s) => s["kind"] === "early_warning" && String(s["title"]).includes("Sol re-session cap hit"),
  );
  assert.ok(capHitStoryline, "expected a Sol re-session cap-hit early_warning storyline");
  assert.equal(
    ((capHitStoryline!["proposed_action"] as Record<string, unknown>)["type"]),
    "add_policy",
  );
  // Evidence surfaces the count + threshold + kinds.
  const evidence = String(capHitStoryline!["evidence"]);
  assert.ok(evidence.includes("6 cap-hits"), `evidence missing count: ${evidence}`);
  assert.ok(evidence.includes("threshold 5"), `evidence missing threshold: ${evidence}`);
  assert.ok(evidence.includes("frustration 4"), `evidence missing frustration: ${evidence}`);
  assert.ok(evidence.includes("drift 2"), `evidence missing drift: ${evidence}`);
});

test("5 cap-hits + threshold=5 → NO cap-hit storyline (strict > not >=)", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => makeCapHitRow(i, "frustration"));
  const { admin, state } = makeAdmin({
    cap_hit_rows: rows,
    ai_channel_config: [{ workspace_id: WS, sol_cap_hit_alarm: 5 }],
  });
  await composeCsDirectorDigest(admin, WS, SINCE, UNTIL);
  const digest = state.inserted_digests[0]!;
  const capHitStoryline = (digest.storylines as Array<Record<string, unknown>>).find(
    (s) => s["kind"] === "early_warning" && String(s["title"]).includes("Sol re-session cap hit"),
  );
  assert.equal(capHitStoryline, undefined, "must NOT emit a cap-hit storyline at count == threshold");
});

test("threshold reads the MAX across the workspace's channel configs", async () => {
  const rows = Array.from({ length: 8 }, (_, i) => makeCapHitRow(i, "frustration"));
  const { admin, state } = makeAdmin({
    cap_hit_rows: rows,
    ai_channel_config: [
      { workspace_id: WS, sol_cap_hit_alarm: 5 },
      { workspace_id: WS, sol_cap_hit_alarm: 10 }, // the loosest bound wins → cap-hit at 8 must NOT fire
    ],
  });
  await composeCsDirectorDigest(admin, WS, SINCE, UNTIL);
  const digest = state.inserted_digests[0]!;
  const capHitStoryline = (digest.storylines as Array<Record<string, unknown>>).find(
    (s) => s["kind"] === "early_warning" && String(s["title"]).includes("Sol re-session cap hit"),
  );
  assert.equal(
    capHitStoryline,
    undefined,
    "8 cap-hits under a max threshold of 10 must NOT emit the storyline",
  );
});

test("no cap-hits + no threshold config → no storyline (default threshold 5 handles empty config)", async () => {
  const { admin, state } = makeAdmin({
    cap_hit_rows: [],
    ai_channel_config: [],
  });
  await composeCsDirectorDigest(admin, WS, SINCE, UNTIL);
  const digest = state.inserted_digests[0]!;
  const capHitStoryline = (digest.storylines as Array<Record<string, unknown>>).find(
    (s) => s["kind"] === "early_warning" && String(s["title"]).includes("Sol re-session cap hit"),
  );
  assert.equal(capHitStoryline, undefined);
});
