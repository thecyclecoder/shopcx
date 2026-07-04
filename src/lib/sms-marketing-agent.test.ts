/**
 * Unit tests for the SMS Marketing Agent cadence engine (docs/brain/inngest/sms-marketing.md).
 * Pure-function coverage of the send gate + body composition — no DB, no side effects.
 *
 * Built-in node:test — run:
 *   npx tsx --test src/lib/sms-marketing-agent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSendGate, composeBody, renderedLength, isGsm7, centralDay,
  type SmsMarketingPolicy,
} from "./sms-marketing-agent";

const POLICY: SmsMarketingPolicy = {
  workspace_id: "ws",
  active: true,
  weekly_send_cap: 2,
  min_days_between_sends: 2,
  send_windows: [
    { weekday: 0, hour: 9, theme: "weekend" },
    { weekday: 1, hour: 9, theme: "vip" },
    { weekday: 2, hour: 18, theme: "vip" },
    { weekday: 4, hour: 9, theme: "vip" },
    { weekday: 6, hour: 9, theme: "weekend" },
  ],
  segment_scope: ["cycle_hitter", "lapsed", "active_sub"],
  theme_config: {
    vip: { code: "VIPWEEKLY", collection: "vip-early-access", discount_label: "up to 60% off" },
    weekend: { code: "WEEKEND", collection: "weekend-sale", discount_label: "up to 50% off" },
  },
};

// A UTC instant that is a given weekday in Central. 2026-07 dates: Jul 5 2026 = Sunday.
// Use noon UTC so the Central calendar day equals the UTC calendar day.
function dayOn(dateStr: string): Date { return new Date(`${dateStr}T17:00:00Z`); } // 12:00 Central (CDT)

test("dormant policy never sends", () => {
  const d = evaluateSendGate({ ...POLICY, active: false }, dayOn("2026-07-06"), []);
  assert.equal(d.send, false);
  assert.match((d as { reason: string }).reason, /dormant/);
});

test("each candidate weekday maps to its theme + hour", () => {
  // 2026-07-05 Sun, 07-06 Mon, 07-07 Tue, 07-09 Thu, 07-11 Sat
  const cases: Array<[string, string, number]> = [
    ["2026-07-05", "weekend", 9],
    ["2026-07-06", "vip", 9],
    ["2026-07-07", "vip", 18],
    ["2026-07-09", "vip", 9],
    ["2026-07-11", "weekend", 9],
  ];
  for (const [date, theme, hour] of cases) {
    const d = evaluateSendGate(POLICY, dayOn(date), []);
    assert.equal(d.send, true, `${date} should send`);
    if (d.send) { assert.equal(d.theme, theme); assert.equal(d.hour, hour); }
  }
});

test("non-candidate weekdays skip", () => {
  for (const date of ["2026-07-08" /*Wed*/, "2026-07-10" /*Fri*/]) {
    assert.equal(evaluateSendGate(POLICY, dayOn(date), []).send, false);
  }
});

test("weekly cap blocks a 3rd send in the same ISO week", () => {
  // week of Mon 07-06 … prior sends Mon+Tue, now Thu.
  const d = evaluateSendGate(POLICY, dayOn("2026-07-09"), ["2026-07-06", "2026-07-07"]);
  assert.equal(d.send, false);
  assert.match((d as { reason: string }).reason, /weekly cap/);
});

test("min-gap blocks a send too soon after the last", () => {
  // last send Mon 07-06, now Tue 07-07 (gap 1 < 2).
  const d = evaluateSendGate(POLICY, dayOn("2026-07-07"), ["2026-07-06"]);
  assert.equal(d.send, false);
  assert.match((d as { reason: string }).reason, /min gap/);
});

test("missing theme coupon config is a rail (escalate, not send)", () => {
  const noVip = { ...POLICY, theme_config: { weekend: POLICY.theme_config.weekend } };
  const d = evaluateSendGate(noVip, dayOn("2026-07-06"), []); // Monday = vip
  assert.equal(d.send, false);
  assert.match((d as { reason: string }).reason, /no coupon/);
});

test("composeBody + guards: block layout, link in middle, ≤160 GSM-7", () => {
  const body = composeBody({ hook: "VIPs only - time to restock!", cta: "Tap to claim:", signoff: "Shed lbs, feel great for summer! Only 39 left!" });
  assert.ok(body.includes("\n\n"), "has block breaks");
  assert.ok(body.indexOf("{shortlink}") < body.lastIndexOf("Shed"), "link is before the signoff (not last)");
  assert.ok(isGsm7(body));
  assert.ok(renderedLength(body) <= 160, `rendered ${renderedLength(body)} ≤ 160`);
});

test("renderedLength accounts for the ~31-char personal shortlink", () => {
  const body = "hi {shortlink}";
  assert.equal(renderedLength(body), "hi ".length + 31);
});

test("isGsm7 rejects emoji / curly quotes", () => {
  assert.equal(isGsm7("straight ' hyphen -"), true);
  assert.equal(isGsm7("emoji 🎆"), false);
  assert.equal(isGsm7("curly ’ quote"), false);
});

test("centralDay returns a 0-6 weekday and YYYY-MM-DD", () => {
  const { weekday, dateStr } = centralDay(dayOn("2026-07-05"));
  assert.equal(weekday, 0); // Sunday
  assert.match(dateStr, /^\d{4}-\d{2}-\d{2}$/);
});
