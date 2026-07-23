/**
 * Security regression (tenant boundary — security review of
 * media-buyer-persist-crowned-winners-and-guard-reactivation): the winner
 * ad-grain → adset lookup that feeds the crowned-winner ledger must resolve
 * meta_ads SCOPED to the current workspace + Meta ad account. A bare
 * `.in("meta_ad_id", …)` could map a FOREIGN workspace's adset and crown it
 * into media_buyer_crowned_winners for the current workspace.
 *
 *   npx tsx --test src/lib/media-buyer/agent.crown-tenant-scope.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveWinnerAdsetMap } from "./agent";

type Row = Record<string, unknown>;

// Fake admin supporting: from("meta_ads").select().eq().eq().in()  (thenable)
function makeAdmin(rows: Row[]) {
  function chain() {
    const eqs: Array<{ col: string; val: unknown }> = [];
    let inCol: string | null = null;
    let inVals: unknown[] = [];
    const c = {
      select() { return c; },
      eq(col: string, val: unknown) { eqs.push({ col, val }); return c; },
      in(col: string, vals: unknown[]) { inCol = col; inVals = vals; return c; },
      then<T>(onF?: (v: { data: Row[]; error: null }) => T) {
        const data = rows.filter(
          (r) =>
            eqs.every((f) => r[f.col] === f.val) &&
            (inCol === null || inVals.includes(r[inCol])),
        );
        return Promise.resolve({ data, error: null }).then(onF);
      },
    };
    return c;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => chain() } as any;
}

test("cross-tenant: a shared meta_ad_id only resolves the CURRENT workspace/account adset", async () => {
  const rows: Row[] = [
    { meta_ad_id: "AD-SHARED", meta_adset_id: "ADSET-MINE", workspace_id: "ws-A", meta_ad_account_id: "acct-A" },
    { meta_ad_id: "AD-SHARED", meta_adset_id: "ADSET-FOREIGN", workspace_id: "ws-B", meta_ad_account_id: "acct-B" },
  ];
  const map = await resolveWinnerAdsetMap(makeAdmin(rows), {
    workspaceId: "ws-A",
    metaAdAccountId: "acct-A",
    winnerAdIds: ["AD-SHARED"],
  });
  assert.equal(map.get("AD-SHARED"), "ADSET-MINE", "must resolve the in-tenant adset");
  assert.notEqual(map.get("AD-SHARED"), "ADSET-FOREIGN", "must NOT resolve the foreign workspace's adset");
  assert.equal(map.size, 1);
});

test("account boundary: same workspace, different ad account → not resolved", async () => {
  const rows: Row[] = [
    { meta_ad_id: "AD-1", meta_adset_id: "ADSET-OTHER-ACCT", workspace_id: "ws-A", meta_ad_account_id: "acct-OTHER" },
  ];
  const map = await resolveWinnerAdsetMap(makeAdmin(rows), {
    workspaceId: "ws-A",
    metaAdAccountId: "acct-A",
    winnerAdIds: ["AD-1"],
  });
  assert.equal(map.size, 0);
});

test("empty winner set → no query, empty map", async () => {
  const map = await resolveWinnerAdsetMap(makeAdmin([]), {
    workspaceId: "ws-A",
    metaAdAccountId: "acct-A",
    winnerAdIds: [],
  });
  assert.equal(map.size, 0);
});
