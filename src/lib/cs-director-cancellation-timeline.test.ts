import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildCancellationTimeline,
  formatCancellationTimelineForBrief,
  CANCELLATION_TIMELINE_EVENT_CAP,
  type CancellationTimelineSubscription,
  type CancellationTimelineEvent,
  type CancellationTimelineOrder,
} from "./cs-director-cancellation-timeline";

const BONNIE_CONTRACT = "27806990509";
const BONNIE_SUB_ID = "bonnie-sub-uuid";

// Ground truth: cancel fired at 2026-07-17T08:39:51, thirty-six minutes AFTER
// the last renewal billed at 2026-07-17T08:03:45. The claim that three renewals
// billed post-cancellation must be structurally impossible to write.
test("bonnie f773b8ec — cancel at 08:39:51 is placed AFTER the charge at 08:03:45", () => {
  const subs: CancellationTimelineSubscription[] = [
    {
      id: BONNIE_SUB_ID,
      shopify_contract_id: BONNIE_CONTRACT,
      status: "cancelled",
      cancelled_at: "2026-07-17T08:39:51.000Z",
    },
  ];
  const events: CancellationTimelineEvent[] = [
    {
      shopify_contract_id: BONNIE_CONTRACT,
      event_type: "new_subscription",
      created_at: "2026-04-01T08:00:00.000Z",
    },
    {
      shopify_contract_id: BONNIE_CONTRACT,
      event_type: "billing_success",
      created_at: "2026-04-01T08:00:00.000Z",
      delta_cents: 6971,
    },
    {
      shopify_contract_id: BONNIE_CONTRACT,
      event_type: "billing_success",
      created_at: "2026-05-28T08:00:00.000Z",
      delta_cents: 6971,
    },
    {
      shopify_contract_id: BONNIE_CONTRACT,
      event_type: "billing_success",
      created_at: "2026-07-17T08:03:45.000Z",
      delta_cents: 6971,
    },
    {
      shopify_contract_id: BONNIE_CONTRACT,
      event_type: "cancellation",
      created_at: "2026-07-17T08:39:51.000Z",
    },
  ];
  const orders: CancellationTimelineOrder[] = [
    {
      order_number: "SC130000",
      created_at: "2026-04-01T08:00:00.000Z",
      total_cents: 6971,
      subscription_id: BONNIE_SUB_ID,
    },
    {
      order_number: "SC131000",
      created_at: "2026-05-28T08:00:00.000Z",
      total_cents: 6971,
      subscription_id: BONNIE_SUB_ID,
    },
    {
      order_number: "SC132000",
      created_at: "2026-07-17T08:03:45.000Z",
      total_cents: 6971,
      subscription_id: BONNIE_SUB_ID,
    },
  ];

  const timelines = buildCancellationTimeline({ subscriptions: subs, events, orders });
  assert.equal(timelines.length, 1);
  const t = timelines[0]!;

  assert.equal(t.shopify_contract_id, BONNIE_CONTRACT);
  assert.equal(t.cancelled_at, "2026-07-17T08:39:51.000Z");

  const cancelIdx = t.rows.findIndex((r) => r.is_cancellation);
  assert.ok(cancelIdx >= 0, "cancellation row must be present");

  // Every charge (billing_success or order) precedes the cancellation. This is
  // the invariant that makes "three post-cancellation renewals" impossible.
  for (let i = 0; i < t.rows.length; i++) {
    const r = t.rows[i]!;
    if (r.is_charge && r.at.startsWith("2026-07-17T08:")) {
      assert.ok(
        i < cancelIdx,
        `same-day charge at ${r.at} should be BEFORE the cancel row (index ${i} < ${cancelIdx})`,
      );
    }
  }

  assert.equal(
    t.post_cancellation_charges,
    0,
    "no charge or renewal order landed strictly after 2026-07-17T08:39:51",
  );
});

test("post-cancellation charge is counted when it truly happens", () => {
  const subs: CancellationTimelineSubscription[] = [
    {
      id: "sub-x",
      shopify_contract_id: "contract-x",
      status: "cancelled",
      cancelled_at: "2026-05-01T00:00:00.000Z",
    },
  ];
  const events: CancellationTimelineEvent[] = [
    {
      shopify_contract_id: "contract-x",
      event_type: "cancellation",
      created_at: "2026-05-01T00:00:00.000Z",
    },
    {
      shopify_contract_id: "contract-x",
      event_type: "billing_success",
      created_at: "2026-05-02T00:00:00.000Z",
      delta_cents: 5000,
    },
  ];
  const timelines = buildCancellationTimeline({ subscriptions: subs, events, orders: [] });
  assert.equal(timelines[0]!.post_cancellation_charges, 1);
});

test("cap truncates and flags — no silent caps", () => {
  const subs: CancellationTimelineSubscription[] = [
    { id: "s", shopify_contract_id: "c", status: "active", cancelled_at: null },
  ];
  const events: CancellationTimelineEvent[] = Array.from({ length: 25 }, (_, i) => ({
    shopify_contract_id: "c",
    event_type: "billing_success",
    created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    delta_cents: 100,
  }));
  const t = buildCancellationTimeline({ subscriptions: subs, events, orders: [] })[0]!;
  assert.equal(t.truncated, true);
  assert.equal(t.rows.length, CANCELLATION_TIMELINE_EVENT_CAP);
});

test("subscription with no cancel is a plain empty-cancelled_at row", () => {
  const subs: CancellationTimelineSubscription[] = [
    { id: "s", shopify_contract_id: "c", status: "active", cancelled_at: null },
  ];
  const t = buildCancellationTimeline({ subscriptions: subs, events: [], orders: [] })[0]!;
  assert.equal(t.cancelled_at, null);
  assert.equal(t.post_cancellation_charges, 0);
});

test("brief formatter renders the CANCELLED marker and post-cancel count", () => {
  const timelines = buildCancellationTimeline({
    subscriptions: [
      {
        id: BONNIE_SUB_ID,
        shopify_contract_id: BONNIE_CONTRACT,
        status: "cancelled",
        cancelled_at: "2026-07-17T08:39:51.000Z",
      },
    ],
    events: [
      {
        shopify_contract_id: BONNIE_CONTRACT,
        event_type: "billing_success",
        created_at: "2026-07-17T08:03:45.000Z",
        delta_cents: 6971,
      },
      {
        shopify_contract_id: BONNIE_CONTRACT,
        event_type: "cancellation",
        created_at: "2026-07-17T08:39:51.000Z",
      },
    ],
    orders: [],
  });
  const out = formatCancellationTimelineForBrief(timelines);
  assert.match(out, /post-cancellation charges: 0/);
  assert.match(out, /CANCELLED 2026-07-17T08:39:51/);
  assert.match(out, /2026-07-17T08:03:45/);
});
