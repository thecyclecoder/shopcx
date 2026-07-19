/**
 * Unit tests for resolveTestCadenceTargets — the intraday 2h pull's target resolver.
 * Verifies: per-test cohorts scope by test_meta_campaign_id; two cohorts in one account merge their
 * campaigns into one grouped pull; a legacy shared-adset cohort resolves its campaign from meta_adsets;
 * a cohort missing account/campaign is skipped.
 *
 * Run: npx tsx --test src/lib/inngest/media-buyer-test-cadence.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTestCadenceTargets, localDayInTz, summarizeCadenceRun, type CadencePullResult } from "./media-buyer-test-cadence";

test("localDayInTz — UTC 07-13 02:38 is still 07-12 in LA and Chicago (the boundary case)", () => {
  const d = new Date("2026-07-13T02:38:00Z"); // 8:38pm Mountain = 7:38pm PT / 9:38pm CT, both 07-12
  assert.equal(localDayInTz(d, "America/Los_Angeles"), "2026-07-12");
  assert.equal(localDayInTz(d, "America/Chicago"), "2026-07-12");
  assert.equal(localDayInTz(d, null), "2026-07-13"); // no tz → UTC fallback
});

type Row = Record<string, unknown>;

function makeAdmin(cohorts: Row[], adsets: Row[], accounts: Row[] = []) {
  return {
    from(table: string) {
      if (table === "media_buyer_test_cohorts") {
        return { select: () => ({ eq: () => Promise.resolve({ data: cohorts, error: null }) }) };
      }
      if (table === "meta_adsets") {
        return {
          select: () => ({
            eq: (_c: string, v: unknown) => ({
              maybeSingle: async () => ({ data: adsets.find((a) => a.meta_adset_id === v) ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === "meta_ad_accounts") {
        return {
          select: () => ({
            in: (_c: string, ids: unknown[]) => Promise.resolve({ data: accounts.filter((a) => (ids as unknown[]).includes(a.id)), error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as Parameters<typeof resolveTestCadenceTargets>[0];
}

const WS = "ws-1";

test("resolveTestCadenceTargets — per-test cohorts scope by test_meta_campaign_id", async () => {
  const admin = makeAdmin(
    [{ workspace_id: WS, meta_ad_account_id: "uuid-cre", default_meta_account_id: "act-cre", adset_per_test: true, test_meta_campaign_id: "camp-cre", test_meta_adset_id: null }],
    [],
  );
  const t = await resolveTestCadenceTargets(admin);
  assert.equal(t.length, 1);
  assert.equal(t[0].adAccountId, "uuid-cre");
  assert.equal(t[0].metaAccountId, "act-cre");
  assert.deepEqual(t[0].campaignIds, ["camp-cre"]);
});

test("resolveTestCadenceTargets — two cohorts in one account merge into ONE grouped pull", async () => {
  const admin = makeAdmin(
    [
      { workspace_id: WS, meta_ad_account_id: "uuid-ash", default_meta_account_id: "act-ash", adset_per_test: true, test_meta_campaign_id: "camp-ash", test_meta_adset_id: null },
      { workspace_id: WS, meta_ad_account_id: "uuid-ash", default_meta_account_id: "act-ash", adset_per_test: true, test_meta_campaign_id: "camp-ash", test_meta_adset_id: null },
    ],
    [],
  );
  const t = await resolveTestCadenceTargets(admin);
  assert.equal(t.length, 1); // one account group
  assert.deepEqual(t[0].campaignIds, ["camp-ash"]); // deduped
});

test("resolveTestCadenceTargets — legacy shared-adset cohort resolves campaign from meta_adsets", async () => {
  const admin = makeAdmin(
    [{ workspace_id: WS, meta_ad_account_id: "uuid-tabs", default_meta_account_id: "act-tabs", adset_per_test: false, test_meta_campaign_id: null, test_meta_adset_id: "adset-tabs" }],
    [{ meta_adset_id: "adset-tabs", meta_campaign_id: "camp-tabs" }],
  );
  const t = await resolveTestCadenceTargets(admin);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].campaignIds, ["camp-tabs"]);
});

test("resolveTestCadenceTargets — attaches each account's Meta timezone", async () => {
  const admin = makeAdmin(
    [
      { workspace_id: WS, meta_ad_account_id: "uuid-cre", default_meta_account_id: "act-cre", adset_per_test: true, test_meta_campaign_id: "camp-cre", test_meta_adset_id: null },
      { workspace_id: WS, meta_ad_account_id: "uuid-tabs", default_meta_account_id: "act-tabs", adset_per_test: false, test_meta_campaign_id: "camp-tabs", test_meta_adset_id: null },
    ],
    [],
    [
      { id: "uuid-cre", timezone: "America/Los_Angeles" },
      { id: "uuid-tabs", timezone: "America/Chicago" },
    ],
  );
  const t = await resolveTestCadenceTargets(admin);
  const byAcct = new Map(t.map((x) => [x.adAccountId, x.timezone]));
  assert.equal(byAcct.get("uuid-cre"), "America/Los_Angeles");
  assert.equal(byAcct.get("uuid-tabs"), "America/Chicago");
});

test("resolveTestCadenceTargets — cohort missing account or resolvable campaign is skipped", async () => {
  const admin = makeAdmin(
    [
      { workspace_id: WS, meta_ad_account_id: null, default_meta_account_id: "act-x", adset_per_test: true, test_meta_campaign_id: "camp-x", test_meta_adset_id: null },
      { workspace_id: WS, meta_ad_account_id: "uuid-y", default_meta_account_id: "act-y", adset_per_test: false, test_meta_campaign_id: null, test_meta_adset_id: "missing-adset" },
    ],
    [], // meta_adsets lookup returns null → campaign unresolvable
  );
  const t = await resolveTestCadenceTargets(admin);
  assert.equal(t.length, 0);
});

// --- failure-heartbeat cases (spec: media-buyer-test-cadence-failure-heartbeat) ---

function ok(account: string): CadencePullResult {
  return { ok: true, account, tz: null, window: { since: "2026-07-19", until: "2026-07-19" }, campaigns: 1, adsets: 1, adsetInsightRows: 1, adInsightRows: 1, scorecardRows: 1 };
}
function bad(account: string, error: string): CadencePullResult {
  return { ok: false, account, error };
}

test("summarizeCadenceRun — all succeeded → ok:true, no rethrow", () => {
  const s = summarizeCadenceRun([ok("act-a"), ok("act-b")]);
  assert.equal(s.succeededTargets, 2);
  assert.equal(s.failedTargets, 0);
  assert.equal(s.ok, true);
  assert.equal(s.allFailed, false);
  assert.equal(s.firstFailure, null);
  assert.match(s.detail, /pulled 2 account/);
});

test("summarizeCadenceRun — PARTIAL failure → ok:false but allFailed=false (heartbeat lands, no rethrow)", () => {
  // One Meta 500 in a two-account sweep is the canonical case: cron reports partial failure
  // and keeps liveness green on Control Tower, but ok flips to false so the Tower sees it.
  const s = summarizeCadenceRun([ok("act-a"), bad("act-b", "graph 500")]);
  assert.equal(s.succeededTargets, 1);
  assert.equal(s.failedTargets, 1);
  assert.equal(s.ok, false);
  assert.equal(s.allFailed, false);
  assert.deepEqual(s.firstFailure, { account: "act-b", error: "graph 500" });
  assert.match(s.detail, /partial: 1 succeeded, 1 failed/);
});

test("summarizeCadenceRun — TOTAL outage → ok:false and allFailed=true (rethrow AFTER heartbeat)", () => {
  const s = summarizeCadenceRun([bad("act-a", "graph 500"), bad("act-b", "graph 500")]);
  assert.equal(s.succeededTargets, 0);
  assert.equal(s.failedTargets, 2);
  assert.equal(s.ok, false);
  assert.equal(s.allFailed, true); // caller rethrows so Inngest failure feed surfaces the outage
  assert.deepEqual(s.firstFailure, { account: "act-a", error: "graph 500" });
});

test("summarizeCadenceRun — no_token counts as failed (config gap should not silently look healthy)", () => {
  const s = summarizeCadenceRun([bad("act-a", "no_token"), ok("act-b")]);
  assert.equal(s.failedTargets, 1);
  assert.equal(s.ok, false);
  assert.equal(s.allFailed, false);
});

test("summarizeCadenceRun — empty results (no targets) → ok:true, allFailed=false", () => {
  // Guardrail: the empty-targets branch of the cron uses its own heartbeat literal; the summarizer's
  // empty case must NOT report allFailed (would trigger a spurious rethrow if the loop ever called it).
  const s = summarizeCadenceRun([]);
  assert.equal(s.ok, true);
  assert.equal(s.allFailed, false);
  assert.equal(s.firstFailure, null);
});
