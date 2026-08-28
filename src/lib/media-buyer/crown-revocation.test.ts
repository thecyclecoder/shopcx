/**
 * Pins the revoked-vs-exhausted distinction (CEO 2026-08-28).
 *
 * The wedge: on 2026-08-25 all five crowns were retired because the crown bar moved (8→15 purchases
 * plus a confidence-bounded CPA) and none still qualified. They were retired with
 * `markExploitExhausted`, the only SDK that existed. Three days later the graduate-stall heartbeat —
 * which counted "eligible" as `graduated_at IS NULL` and nothing else — was still raising CEO cards
 * claiming Superfood Tabs had "3 crowned winners but no graduate in the last 7 days" and Zen Relax
 * "2". Genuine pending work in both cohorts: ZERO, and the cohorts were 3 days old against a 7-day
 * window.
 *
 * A stall card for work that does not exist trains the reader to ignore stall cards, which is worse
 * than having none.
 *
 * Run: npx tsx --test src/lib/media-buyer/crown-revocation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countEligibleCrownedWinnersByCohort } from "./cold-scaler-graduate-heartbeat";

type Row = { meta_ad_account_id: string | null; product_id: string | null; graduated_at: string | null; revoked_at: string | null };

/** Admin stub that applies the same `.is()` filters the real query uses. */
function stubAdmin(rows: Row[]) {
  return {
    from() {
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq() { return chain; },
        is(col: string, val: unknown) { filters.push([col, val]); return chain; },
        then(resolve: (r: { data: Row[] }) => unknown) {
          const out = rows.filter((r) =>
            filters.every(([col, val]) => val !== null || (r as unknown as Record<string, unknown>)[col] === null),
          );
          return Promise.resolve(resolve({ data: out }));
        },
      };
      return chain;
    },
  } as never;
}

const SCOPE = [{ cohortId: "cohort-A", metaAdAccountId: "acct-1", productId: "prod-1" }];
const live = (): Row => ({ meta_ad_account_id: "acct-1", product_id: "prod-1", graduated_at: null, revoked_at: null });
const revoked = (): Row => ({ ...live(), revoked_at: "2026-08-25T14:13:00Z" });
const graduated = (): Row => ({ ...live(), graduated_at: "2026-08-20T10:00:00Z" });

test("a live crown counts as pending graduate work", async () => {
  const n = await countEligibleCrownedWinnersByCohort(stubAdmin([live(), live()]), { workspaceId: "ws", cohortScopes: SCOPE });
  assert.equal(n.get("cohort-A"), 2);
});

test("⭐ a REVOKED crown is not pending work — the wedge that raised phantom CEO cards", async () => {
  const n = await countEligibleCrownedWinnersByCohort(
    stubAdmin([revoked(), revoked(), revoked()]),
    { workspaceId: "ws", cohortScopes: SCOPE },
  );
  assert.equal(n.get("cohort-A"), 0, "3 retired crowns must not read as 3 winners awaiting graduation");
});

test("an already-graduated crown is not pending work either (pre-existing behaviour, unchanged)", async () => {
  const n = await countEligibleCrownedWinnersByCohort(stubAdmin([graduated()]), { workspaceId: "ws", cohortScopes: SCOPE });
  assert.equal(n.get("cohort-A"), 0);
});

test("a mixed set counts only the live ones", async () => {
  const n = await countEligibleCrownedWinnersByCohort(
    stubAdmin([live(), revoked(), graduated(), live(), revoked()]),
    { workspaceId: "ws", cohortScopes: SCOPE },
  );
  assert.equal(n.get("cohort-A"), 2);
});

test("a cohort with no matching crowns reads 0, not undefined", async () => {
  const other: Row = { meta_ad_account_id: "acct-9", product_id: "prod-9", graduated_at: null, revoked_at: null };
  const n = await countEligibleCrownedWinnersByCohort(stubAdmin([other]), { workspaceId: "ws", cohortScopes: SCOPE });
  assert.equal(n.get("cohort-A"), 0);
});

test("no scopes ⇒ empty map, and the query is skipped entirely", async () => {
  const n = await countEligibleCrownedWinnersByCohort(stubAdmin([live()]), { workspaceId: "ws", cohortScopes: [] });
  assert.equal(n.size, 0);
});
