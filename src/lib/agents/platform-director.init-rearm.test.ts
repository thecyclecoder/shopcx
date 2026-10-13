/**
 * `alreadyInitiated` — an init-lane ESCALATION holds a spec only while its CEO card is open.
 *
 * Ground truth 2026-10-13: close-snapshot-coverage-guard hit the init loop guard on 2026-09-08, its
 * `initguard:` card was dismissed, and nothing ever re-armed it. It sat planned and unbuilt for five
 * weeks. A dismissed card must re-arm the spec; a director's own `init_dismissed` stays terminal.
 *
 * Run: npx tsx --test src/lib/agents/platform-director.init-rearm.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyInitiated } from "@/lib/agents/platform-director";

type Row = Record<string, unknown>;

/** Minimal chainable stand-in for the two reads `alreadyInitiated` makes. */
function fakeAdmin(tables: { director_activity: Row[]; dashboard_notifications: Row[] }, failNotifications = false) {
  return {
    from(table: "director_activity" | "dashboard_notifications") {
      let rows = [...tables[table]];
      const chain = {
        select: () => chain,
        eq: (col: string, v: unknown) => { rows = rows.filter((r) => r[col] === v); return chain; },
        in: (col: string, vs: unknown[]) => {
          rows = rows.filter((r) => {
            const val = col === "metadata->>dedupe_key" ? (r.metadata as Row | undefined)?.dedupe_key : r[col];
            return vs.includes(val);
          });
          return chain;
        },
        order: () => chain,
        limit: async () =>
          table === "dashboard_notifications" && failNotifications
            ? { data: null, error: { message: "boom" } }
            : { data: rows, error: null },
      };
      return chain;
    },
  } as never;
}

const WS = "ws-1";
const SLUG = "close-snapshot-coverage-guard";
const escalation = { workspace_id: WS, director_function: "platform", action_kind: "escalated", metadata: { dedupe_key: `initguard:${SLUG}` } };
const card = (dismissed: boolean) => ({ workspace_id: WS, dismissed, metadata: { dedupe_key: `initguard:${SLUG}` } });

test("an escalation with an OPEN card still holds the spec", async () => {
  const admin = fakeAdmin({ director_activity: [escalation], dashboard_notifications: [card(false)] });
  assert.equal(await alreadyInitiated(admin, SLUG, WS), true);
});

test("a DISMISSED card re-arms the spec (the close-snapshot-coverage-guard strand)", async () => {
  const admin = fakeAdmin({ director_activity: [escalation], dashboard_notifications: [card(true)] });
  assert.equal(await alreadyInitiated(admin, SLUG, WS), false);
});

test("a card read error fails closed (holds the spec)", async () => {
  const admin = fakeAdmin({ director_activity: [escalation], dashboard_notifications: [] }, true);
  assert.equal(await alreadyInitiated(admin, SLUG, WS), true);
});

test("the director's own init_dismissed stays terminal regardless of cards", async () => {
  const admin = fakeAdmin({
    director_activity: [{ workspace_id: WS, director_function: "platform", action_kind: "init_dismissed", metadata: { init_key: `init:${SLUG}` } }],
    dashboard_notifications: [],
  });
  assert.equal(await alreadyInitiated(admin, SLUG, WS), true);
});

test("another workspace's escalation does not hold this one", async () => {
  const admin = fakeAdmin({ director_activity: [{ ...escalation, workspace_id: "ws-2" }], dashboard_notifications: [card(false)] });
  assert.equal(await alreadyInitiated(admin, SLUG, WS), false);
});
