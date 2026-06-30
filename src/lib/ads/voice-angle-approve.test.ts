/**
 * Unit tests for the voice-angle approval executor + enqueuer
 * (growth-customer-voice-to-ad-angles spec, Phase 3).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:voice-angle-approve
 *   (= tsx --test src/lib/ads/voice-angle-approve.test.ts)
 *
 * Covers the spec verification checks:
 *   - executeApproveVoiceAngle flips the angle to status='approved', inserts an ad_campaigns row at
 *     status='ready' tagged to the angle, fires `ad-tool/static-requested`, and stamps one
 *     `director_activity` row of action_kind='approved_voice_angle'.
 *   - readApproveVoiceAnglePayload rejects malformed pending-action payloads.
 *   - buildApproveVoiceAngleAction produces a typed pending action with the carried payload.
 *   - executeApprovedVoiceAngles mutates the pending_actions array in place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVE_VOICE_ANGLE_ACTION_TYPE,
  APPROVED_VOICE_ANGLE_ACTION_KIND,
  buildApproveVoiceAngleAction,
  DEFAULT_VOICE_ANGLE_ARCHETYPE,
  executeApproveVoiceAngle,
  executeApprovedVoiceAngles,
  readApproveVoiceAnglePayload,
  type VoiceAngleExecDeps,
} from "./voice-angle-approve";

// ── Fake admin client — chainable per-table thenable + capture of writes. ────────────────────────
interface FakeWrite { table: string; kind: "insert" | "update"; values?: unknown; patch?: unknown; }

function makeAdmin(opts: {
  angleRow: Record<string, unknown> | null;
  workspaceRow: Record<string, unknown> | null;
  productRow: Record<string, unknown> | null;
  insertedCampaign: { data: Record<string, unknown> | null; error: null | { message: string } };
  updateAngleErr?: { message: string } | null;
}) {
  const writes: FakeWrite[] = [];
  function chain(
    read: { data: unknown; error: null | { message: string } },
    handlers?: { onInsert?: (values: unknown) => { data?: unknown; error: null | { message: string } }; onUpdate?: (patch: unknown) => { data?: unknown; error: null | { message: string } } },
  ) {
    const obj: Record<string, unknown> = {};
    let writeResult: { data?: unknown; error: null | { message: string } } | null = null;
    obj.select = () => obj;
    obj.eq = () => obj;
    obj.in = () => obj;
    obj.not = () => obj;
    obj.is = () => obj;
    obj.maybeSingle = () => obj;
    obj.single = () => obj;
    obj.insert = (values: unknown) => {
      writes.push({ table: "_pending", kind: "insert", values });
      if (handlers?.onInsert) writeResult = handlers.onInsert(values);
      return obj;
    };
    obj.update = (patch: unknown) => {
      writes.push({ table: "_pending", kind: "update", patch });
      if (handlers?.onUpdate) writeResult = handlers.onUpdate(patch);
      return obj;
    };
    obj.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(writeResult ?? read).then(onFulfilled);
    return obj;
  }

  const admin = {
    from(table: string) {
      if (table === "product_ad_angles") {
        return chain(
          { data: opts.angleRow, error: null },
          { onUpdate: () => ({ error: opts.updateAngleErr ?? null }) },
        );
      }
      if (table === "workspaces") return chain({ data: opts.workspaceRow, error: null });
      if (table === "products") return chain({ data: opts.productRow, error: null });
      if (table === "ad_campaigns") {
        return chain(
          { data: null, error: null },
          { onInsert: () => opts.insertedCampaign },
        );
      }
      return chain({ data: null, error: null });
    },
  };
  // Re-tag each write with the table the from(...) call labeled it for — the chain itself doesn't know
  // its table, so we tag after the fact. Simpler: callers inspect writes by kind + values shape, which
  // is fine for these tests (only ad_campaigns is inserted; only product_ad_angles is updated).
  return { admin, writes };
}

function makeSpyDeps(): {
  deps: VoiceAngleExecDeps;
  sentInngest: Array<{ name: string; data: unknown }>;
  recordedActivity: Array<Record<string, unknown>>;
} {
  const sentInngest: Array<{ name: string; data: unknown }> = [];
  const recordedActivity: Array<Record<string, unknown>> = [];
  return {
    deps: {
      sendInngest: async (event) => { sentInngest.push(event); return { ids: ["stub"] }; },
      recordActivity: async (_admin, row) => { recordedActivity.push(row as unknown as Record<string, unknown>); return undefined; },
    },
    sentInngest,
    recordedActivity,
  };
}

test("executeApproveVoiceAngle approves the angle + inserts campaign + fires static + logs activity", async () => {
  const { admin, writes } = makeAdmin({
    angleRow: { id: "ang-1", status: "proposed", product_id: "prod-1", hook_one_liner: "Clean energy, no jitters" },
    workspaceRow: { storefront_domain: "shop.superfoods.com", storefront_slug: null },
    productRow: { handle: "matcha" },
    insertedCampaign: { data: { id: "camp-99" }, error: null },
  });
  const { deps, sentInngest, recordedActivity } = makeSpyDeps();

  const res = await executeApproveVoiceAngle(admin as unknown as Parameters<typeof executeApproveVoiceAngle>[0], {
    workspaceId: "ws-1",
    specSlug: "growth-customer-voice-to-ad-angles",
    payload: {
      angle_id: "ang-1",
      product_id: "prod-1",
      source_signal_counts: { positive: 3, objection: 1, use_case: 2 },
      archetype: "testimonial",
    },
    deps,
  });

  assert.equal(res.ok, true);
  assert.equal(res.ad_campaign_id, "camp-99");

  // Find the ad_campaigns insert (by values shape — it carries angle_id + product_id + status='ready').
  const campaignInsert = writes.find(
    (w) => w.kind === "insert" && (w.values as Record<string, unknown>)?.angle_id === "ang-1",
  );
  assert.ok(campaignInsert, "expected an ad_campaigns insert tagged to the angle");
  const insVal = campaignInsert!.values as Record<string, unknown>;
  assert.equal(insVal.product_id, "prod-1");
  assert.equal(insVal.workspace_id, "ws-1");
  assert.equal(insVal.status, "ready");
  assert.equal(insVal.landing_url, "https://shop.superfoods.com/matcha");
  assert.match(String(insVal.name), /Voice angle ·/);

  // Find the product_ad_angles update (by patch shape — status:'approved').
  const angleUpdate = writes.find(
    (w) => w.kind === "update" && (w.patch as Record<string, unknown>)?.status === "approved",
  );
  assert.ok(angleUpdate, "expected an angle update to status='approved'");
  assert.deepEqual(angleUpdate!.patch, { status: "approved", is_active: true });

  assert.equal(sentInngest.length, 1);
  assert.equal(sentInngest[0].name, "ad-tool/static-requested");
  assert.deepEqual(sentInngest[0].data, { workspace_id: "ws-1", campaign_id: "camp-99", archetype: "testimonial" });

  assert.equal(recordedActivity.length, 1);
  const row = recordedActivity[0] as { actionKind: string; directorFunction: string; metadata: Record<string, unknown> };
  assert.equal(row.actionKind, APPROVED_VOICE_ANGLE_ACTION_KIND);
  assert.equal(row.directorFunction, "growth");
  assert.equal(row.metadata.angle_id, "ang-1");
  assert.equal(row.metadata.ad_campaign_id, "camp-99");
  assert.deepEqual(row.metadata.source_signal_counts, { positive: 3, objection: 1, use_case: 2 });
});

test("executeApproveVoiceAngle is idempotent for an already-approved angle (no second campaign)", async () => {
  const { admin, writes } = makeAdmin({
    angleRow: { id: "ang-2", status: "approved", product_id: "prod-2", hook_one_liner: "Already done" },
    workspaceRow: { storefront_domain: null, storefront_slug: "superfoods" },
    productRow: { handle: "kale" },
    insertedCampaign: { data: { id: "camp-NA" }, error: null },
  });
  const { deps, sentInngest, recordedActivity } = makeSpyDeps();

  const res = await executeApproveVoiceAngle(admin as unknown as Parameters<typeof executeApproveVoiceAngle>[0], {
    workspaceId: "ws-2",
    payload: {
      angle_id: "ang-2",
      product_id: "prod-2",
      source_signal_counts: { positive: 1, objection: 0, use_case: 0 },
      archetype: "testimonial",
    },
    deps,
  });

  assert.equal(res.ok, true);
  assert.equal(res.reason, "already_approved");
  // No campaign insert + no angle update + no event + no activity row.
  assert.equal(writes.filter((w) => w.kind === "insert").length, 0);
  assert.equal(writes.filter((w) => w.kind === "update").length, 0);
  assert.equal(sentInngest.length, 0);
  assert.equal(recordedActivity.length, 0);
});

test("buildApproveVoiceAngleAction produces a typed pending action with the carried payload", () => {
  const a = buildApproveVoiceAngleAction("act-1", {
    angle_id: "ang-3",
    product_id: "prod-3",
    source_signal_counts: { positive: 2, objection: 0, use_case: 1 },
    archetype: DEFAULT_VOICE_ANGLE_ARCHETYPE,
  });
  assert.equal(a.id, "act-1");
  assert.equal(a.type, APPROVE_VOICE_ANGLE_ACTION_TYPE);
  assert.equal(a.status, "pending");
  assert.equal(a.payload.angle_id, "ang-3");
  assert.match(a.summary, /Approve voice-mined angle/);
});

test("readApproveVoiceAnglePayload rejects malformed payloads and accepts well-formed ones", () => {
  assert.equal(readApproveVoiceAnglePayload({ type: APPROVE_VOICE_ANGLE_ACTION_TYPE, status: "approved" }), null);
  assert.equal(readApproveVoiceAnglePayload({ payload: { angle_id: "x" } }), null); // no product_id
  const ok = readApproveVoiceAnglePayload({
    payload: { angle_id: "ang-1", product_id: "prod-1", source_signal_counts: { positive: 1 } },
  });
  assert.ok(ok);
  assert.equal(ok!.angle_id, "ang-1");
  assert.equal(ok!.archetype, DEFAULT_VOICE_ANGLE_ARCHETYPE);
  assert.deepEqual(ok!.source_signal_counts, { positive: 1, objection: 0, use_case: 0 });
});

test("executeApprovedVoiceAngles mutates pending_actions in place (status='done' on success)", async () => {
  const { admin } = makeAdmin({
    angleRow: { id: "ang-7", status: "proposed", product_id: "prod-7", hook_one_liner: null },
    workspaceRow: { storefront_domain: null, storefront_slug: null },
    productRow: { handle: null },
    insertedCampaign: { data: { id: "camp-7" }, error: null },
  });
  const { deps } = makeSpyDeps();

  const target = {
    id: "tgt-1",
    workspace_id: "ws-7",
    spec_slug: "growth-customer-voice-to-ad-angles",
    pending_actions: [
      {
        id: "act-1",
        type: APPROVE_VOICE_ANGLE_ACTION_TYPE,
        status: "approved",
        payload: {
          angle_id: "ang-7",
          product_id: "prod-7",
          source_signal_counts: { positive: 1, objection: 1, use_case: 1 },
          archetype: "testimonial",
        },
      },
    ] as Array<Record<string, unknown>>,
  };

  const out = await executeApprovedVoiceAngles(
    admin as unknown as Parameters<typeof executeApprovedVoiceAngles>[0],
    target as unknown as Parameters<typeof executeApprovedVoiceAngles>[1],
    deps,
  );
  assert.equal(out.ok, true);
  assert.equal(out.executed.length, 1);
  assert.equal(out.executed[0].ok, true);
  assert.equal(out.executed[0].ad_campaign_id, "camp-7");
  const action = target.pending_actions[0] as { status?: string; result?: string };
  assert.equal(action.status, "done");
  assert.match(action.result || "", /approved → ad_campaigns camp-7/);
});
