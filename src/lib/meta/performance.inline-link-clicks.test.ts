// Pin the Graph `inline_link_clicks` → meta_insights_daily.inline_link_clicks
// mapping (Dahlia M3 leading-signal phase 1). The invariant is dual:
//   - a numeric Graph value lands as an integer on the row;
//   - an absent/undefined/blank Graph value lands as NULL (NOT 0) so per-mode
//     CTR readers can EXCLUDE it from their average — the pre-migration gap
//     must not skew the numerator/denominator.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mapInsightsRecords } from "./performance";

const P = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  adAccountId: "00000000-0000-0000-0000-000000000002",
  metaAccountId: "1234567890",
  accessToken: "token",
};
const NOW = "2026-07-17T00:00:00.000Z";

test("Graph inline_link_clicks:37 lands on row as inline_link_clicks=37", () => {
  const rows = [
    {
      ad_id: "120000000000000001",
      date_start: "2026-07-16",
      spend: "12.34",
      impressions: "1000",
      clicks: "42",
      ctr: "4.2",
      cpc: "0.29",
      frequency: "1.1",
      actions: [],
      action_values: [],
      inline_link_clicks: "37",
    },
  ];
  const [rec] = mapInsightsRecords(P, "ad", rows, NOW);
  assert.equal(rec.inline_link_clicks, 37);
});

test("numeric Graph inline_link_clicks (not a string) lands correctly", () => {
  const rows = [
    {
      ad_id: "120000000000000002",
      date_start: "2026-07-16",
      spend: "1.00",
      impressions: "100",
      clicks: "3",
      ctr: "3",
      cpc: "0.33",
      frequency: "1",
      actions: [],
      action_values: [],
      inline_link_clicks: 5,
    },
  ];
  const [rec] = mapInsightsRecords(P, "ad", rows, NOW);
  assert.equal(rec.inline_link_clicks, 5);
});

test("absent Graph inline_link_clicks lands as NULL (not 0)", () => {
  const rows = [
    {
      ad_id: "120000000000000003",
      date_start: "2026-07-16",
      spend: "1.00",
      impressions: "100",
      clicks: "3",
      ctr: "3",
      cpc: "0.33",
      frequency: "1",
      actions: [],
      action_values: [],
      // NO inline_link_clicks key
    },
  ];
  const [rec] = mapInsightsRecords(P, "ad", rows, NOW);
  assert.equal(rec.inline_link_clicks, null);
});

test("blank Graph inline_link_clicks lands as NULL (not 0)", () => {
  const rows = [
    {
      ad_id: "120000000000000004",
      date_start: "2026-07-16",
      spend: "1.00",
      impressions: "100",
      clicks: "3",
      ctr: "3",
      cpc: "0.33",
      frequency: "1",
      actions: [],
      action_values: [],
      inline_link_clicks: "",
    },
  ];
  const [rec] = mapInsightsRecords(P, "ad", rows, NOW);
  assert.equal(rec.inline_link_clicks, null);
});

test("Graph inline_link_clicks:0 lands as 0 (a real reported zero is NOT null)", () => {
  const rows = [
    {
      ad_id: "120000000000000005",
      date_start: "2026-07-16",
      spend: "1.00",
      impressions: "100",
      clicks: "3",
      ctr: "3",
      cpc: "0.33",
      frequency: "1",
      actions: [],
      action_values: [],
      inline_link_clicks: "0",
    },
  ];
  const [rec] = mapInsightsRecords(P, "ad", rows, NOW);
  assert.equal(rec.inline_link_clicks, 0);
});
