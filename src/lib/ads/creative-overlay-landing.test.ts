/**
 * Phase-5 unit tests for the overlay-landing surface
 * (dahlia-competitor-ad-adaptation-overlay-render). Pins the exact write targets the ad
 * detail page reads:
 *   • `product_ad_angles.metadata.copy_pack` — the primary detail-page fallback when
 *     `readCopyVariants` is empty (splat-preserves existing metadata);
 *   • `ad_videos` per-ratio rows — canonical `feed_4x5` + siblings pointing at it via
 *     `format_variant_of_id`, each with `meta.storage_path=finals/{ws}/{videoId}.{ext}`
 *     the route re-signs from;
 *   • `ad_creative_copy_variants` — the temperature-banded pack via `writeCopyVariants`.
 *
 * All writes carry compare-and-set guards (`.eq('id').eq('workspace_id')` + `.select('id')`)
 * per coaching #11-12 — a cross-workspace / stale-row bleed on a landing write is a
 * data-integrity defect. Tests pin every guard against a fake admin client that records the
 * chain calls; the storage seam is injected so no real bucket / network is touched.
 *
 * Run: npx tsx --test src/lib/ads/creative-overlay-landing.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAngleCopyPackUpdateBody,
  landOverlayCreativePack,
  OVERLAY_LANDING_TARGETS,
  overlayFinalsStoragePath,
  type OverlayLandingStorage,
} from "./creative-overlay-landing";
import type { MetaCopyPack, RenderedPlacement } from "./creative-pack";
import type { AuthorModeCopyVariant } from "./creative-agent";

function makeCopyPack(): MetaCopyPack {
  return {
    headlines: ["h1", "h2", "h3", "h4"],
    primaryTexts: ["p1\n\np1b\n\np1c", "p2\n\np2b\n\np2c", "p3\n\np3b\n\np3c", "p4\n\np4b\n\np4c"],
    description: "d",
    frameworks: ["lf8", "schwartz", "cialdini", "hopkins"],
  };
}
function makeRender(format: "feed_4x5" | "stories_9x16" | "right_column_1x1", mime = "image/jpeg"): RenderedPlacement {
  return { format, buffer: Buffer.from([1, 2, 3]), mimeType: mime };
}

// ── Fake admin with recording chains ─────────────────────────────────────────
interface RecordedCall {
  op: "select" | "insert" | "update" | "upsert";
  table: string;
  body?: unknown;
  filters: Record<string, unknown>;
  selectCols?: string;
  singleCalled: boolean;
  upsertOpts?: { onConflict?: string };
}

interface FakeAdminOpts {
  /** Rows returned by `select().eq(...).single()` per table. Undefined → `data=null`. */
  selectReturns?: Record<string, unknown>;
  /** Rows returned by `insert().select('id').single()`, keyed by table (returned once per call in order). */
  insertReturns?: Record<string, Array<{ id?: string; error?: { message: string } }>>;
  /** Rows returned by `update().eq(...).eq(...).select('id')`, keyed by table (returned once per call in order). */
  updateReturns?: Record<string, Array<Array<{ id: string }> | { error: { message: string } }>>;
  /** Rows returned by `upsert(rows, opts).select('id')`, keyed by table. */
  upsertReturns?: Record<string, Array<Array<{ id: string }>>>;
}

function makeFakeAdmin(opts: FakeAdminOpts = {}): { admin: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const insertQueues: Record<string, Array<{ id?: string; error?: { message: string } }>> = { ...(opts.insertReturns ?? {}) };
  const updateQueues: Record<string, Array<Array<{ id: string }> | { error: { message: string } }>> = { ...(opts.updateReturns ?? {}) };
  const upsertQueues: Record<string, Array<Array<{ id: string }>>> = { ...(opts.upsertReturns ?? {}) };
  function nextInsert(table: string): { id?: string; error?: { message: string } } {
    const q = insertQueues[table] ?? [];
    return q.shift() ?? { id: `${table}-generated-${Math.floor(Math.random() * 1e6)}` };
  }
  function nextUpdate(table: string): Array<{ id: string }> | { error: { message: string } } {
    const q = updateQueues[table] ?? [];
    return q.shift() ?? [{ id: "generic-1" }];
  }
  function nextUpsert(table: string): Array<{ id: string }> {
    const q = upsertQueues[table] ?? [];
    return q.shift() ?? [];
  }

  function chainFromTable(table: string) {
    return {
      select(cols: string) {
        const call: RecordedCall = { op: "select", table, filters: {}, selectCols: cols, singleCalled: false };
        calls.push(call);
        const builder = {
          eq(k: string, v: unknown) { call.filters[k] = v; return builder; },
          async single() { call.singleCalled = true; return { data: opts.selectReturns?.[table] ?? null, error: null }; },
          then(onFulfilled: (v: { data: unknown; error: null }) => unknown) { return Promise.resolve({ data: null, error: null }).then(onFulfilled); },
        };
        return builder;
      },
      insert(body: unknown) {
        const call: RecordedCall = { op: "insert", table, body, filters: {}, singleCalled: false };
        calls.push(call);
        return {
          select(cols: string) {
            call.selectCols = cols;
            return {
              async single() { call.singleCalled = true; const r = nextInsert(table); return r.error ? { data: null, error: r.error } : { data: { id: r.id }, error: null }; },
              async then(onFulfilled: (v: unknown) => unknown) { const r = nextInsert(table); return onFulfilled({ data: r.error ? null : [{ id: r.id }], error: r.error ?? null }); },
            };
          },
        };
      },
      update(body: unknown) {
        const call: RecordedCall = { op: "update", table, body, filters: {}, singleCalled: false };
        calls.push(call);
        const eqChain = {
          eq(k: string, v: unknown) { call.filters[k] = v; return eqChain; },
          select(cols: string) {
            call.selectCols = cols;
            const r = nextUpdate(table);
            if ("error" in r) return Promise.resolve({ data: null, error: r.error });
            return Promise.resolve({ data: r, error: null });
          },
          then(onFulfilled: (v: unknown) => unknown) { const r = nextUpdate(table); return Promise.resolve({ data: "error" in r ? null : r, error: "error" in r ? r.error : null }).then(onFulfilled); },
        };
        return eqChain;
      },
      upsert(rows: unknown[], upsertOpts: { onConflict?: string }) {
        const call: RecordedCall = { op: "upsert", table, body: rows, filters: {}, singleCalled: false, upsertOpts };
        calls.push(call);
        return {
          select(cols: string) {
            call.selectCols = cols;
            return Promise.resolve({ data: nextUpsert(table), error: null });
          },
        };
      },
    };
  }

  return { admin: { from: chainFromTable }, calls };
}

function makeFakeStorage(): { storage: OverlayLandingStorage; uploads: Array<{ path: string; contentType: string }>; signs: string[] } {
  const uploads: Array<{ path: string; contentType: string }> = [];
  const signs: string[] = [];
  const storage: OverlayLandingStorage = {
    async uploadBuffer(path, _buffer, contentType) { uploads.push({ path, contentType }); return path; },
    async signedUrl(path) { signs.push(path); return `signed://${path}`; },
  };
  return { storage, uploads, signs };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("OVERLAY_LANDING_TARGETS: enumerates the three write surfaces the ad detail page reads", () => {
  assert.deepEqual(OVERLAY_LANDING_TARGETS, {
    copyVariants: "ad_creative_copy_variants",
    angleCopyPack: "product_ad_angles.metadata.copy_pack",
    adVideos: "ad_videos",
  });
});

test("overlayFinalsStoragePath: produces the canonical `finals/{ws}/{videoId}.{ext}` pattern", () => {
  assert.equal(overlayFinalsStoragePath("ws-abc", "video-123", "jpg"), "finals/ws-abc/video-123.jpg");
  assert.equal(overlayFinalsStoragePath("ws-abc", "video-123", "png"), "finals/ws-abc/video-123.png");
});

test("buildAngleCopyPackUpdateBody: preserves the angle's existing metadata (provenance / concept tags) while writing copy_pack", () => {
  const prior = { provenance: { mode: "explore", isCompetitor: true }, concept_tag: "curiosity" };
  const body = buildAngleCopyPackUpdateBody(prior, makeCopyPack());
  assert.deepEqual(body.metadata.provenance, prior.provenance, "existing provenance is preserved");
  assert.deepEqual(body.metadata.concept_tag, "curiosity", "existing concept_tag is preserved");
  assert.deepEqual((body.metadata as { copy_pack: MetaCopyPack }).copy_pack, makeCopyPack());
});

test("buildAngleCopyPackUpdateBody: null existing metadata → metadata carries only copy_pack", () => {
  const body = buildAngleCopyPackUpdateBody(null, makeCopyPack());
  assert.deepEqual(Object.keys(body.metadata), ["copy_pack"]);
});

// ── landOverlayCreativePack — the write orchestrator ─────────────────────────

test("landOverlayCreativePack: writes copy_pack onto product_ad_angles with compare-and-set on id + workspace_id", async () => {
  const { admin, calls } = makeFakeAdmin({
    selectReturns: { product_ad_angles: { metadata: { provenance: { mode: "explore" } } } },
    insertReturns: {
      ad_videos: [{ id: "video-canonical" }, { id: "video-stories" }, { id: "video-right" }],
    },
  });
  const { storage } = makeFakeStorage();
  const result = await landOverlayCreativePack(admin as never, {
    workspaceId: "ws-1",
    campaignId: "campaign-1",
    angleId: "angle-1",
    canonicalRender: makeRender("feed_4x5"),
    siblingRenders: [makeRender("stories_9x16"), makeRender("right_column_1x1")],
    copyPack: makeCopyPack(),
    storage,
  });
  assert.equal(result.angleCopyPackWritten, true);

  const angleSelect = calls.find((c) => c.op === "select" && c.table === "product_ad_angles");
  assert.ok(angleSelect, "reads existing angle metadata before writing");
  assert.deepEqual(angleSelect.filters, { id: "angle-1", workspace_id: "ws-1" }, "compare-and-set on angle id + workspace_id");

  const angleUpdate = calls.find((c) => c.op === "update" && c.table === "product_ad_angles");
  assert.ok(angleUpdate, "angle copy_pack write happens");
  assert.deepEqual(angleUpdate.filters, { id: "angle-1", workspace_id: "ws-1" }, "compare-and-set guards the update too");
  assert.equal(angleUpdate.selectCols, "id", ".select('id') asserts exactly one row transitioned");
  const updateBody = angleUpdate.body as { metadata: Record<string, unknown> };
  assert.deepEqual((updateBody.metadata as { copy_pack: MetaCopyPack }).copy_pack, makeCopyPack(), "copy_pack lands in the angle's metadata");
  assert.deepEqual(updateBody.metadata.provenance, { mode: "explore" }, "prior provenance is preserved (never clobbered)");
});

test("landOverlayCreativePack: inserts canonical ad_videos row → uploads to finals/{ws}/{videoId}.jpg → flips to ready with meta.storage_path", async () => {
  const { admin, calls } = makeFakeAdmin({
    selectReturns: { product_ad_angles: { metadata: null } },
    insertReturns: {
      ad_videos: [{ id: "video-canonical" }, { id: "video-stories" }, { id: "video-right" }],
    },
  });
  const { storage, uploads, signs } = makeFakeStorage();
  const res = await landOverlayCreativePack(admin as never, {
    workspaceId: "ws-1",
    campaignId: "campaign-1",
    angleId: "angle-1",
    canonicalRender: makeRender("feed_4x5"),
    siblingRenders: [makeRender("stories_9x16"), makeRender("right_column_1x1")],
    copyPack: makeCopyPack(),
    storage,
  });
  assert.equal(res.canonicalAdVideoId, "video-canonical");

  // Insert body — feed_4x5, static, pending, no format_variant_of_id.
  const canonicalInsert = calls.find((c) => c.op === "insert" && c.table === "ad_videos" && (c.body as { format?: string }).format === "feed_4x5");
  assert.ok(canonicalInsert, "canonical ad_videos insert exists");
  const canonicalBody = canonicalInsert.body as { format_variant_of_id: string | null; media_kind: string; status: string; workspace_id: string; campaign_id: string; meta: { archetype: string; generated_by: string } };
  assert.equal(canonicalBody.format_variant_of_id, null, "canonical has no format_variant_of_id");
  assert.equal(canonicalBody.media_kind, "static");
  assert.equal(canonicalBody.status, "pending");
  assert.equal(canonicalBody.workspace_id, "ws-1");
  assert.equal(canonicalBody.campaign_id, "campaign-1");
  assert.equal(canonicalBody.meta.generated_by, "ad-creative-overlay", "generated_by distinguishes overlay-path landings");

  // Upload — finals/{ws}/{videoId}.jpg pattern.
  assert.deepEqual(uploads[0], { path: "finals/ws-1/video-canonical.jpg", contentType: "image/jpeg" });
  assert.deepEqual(signs[0], "finals/ws-1/video-canonical.jpg");

  // Update flips to ready + stamps meta.storage_path (compare-and-set on id + workspace_id).
  const canonicalUpdate = calls.find((c) => c.op === "update" && c.table === "ad_videos" && c.filters.id === "video-canonical");
  assert.ok(canonicalUpdate);
  assert.deepEqual(canonicalUpdate.filters, { id: "video-canonical", workspace_id: "ws-1" }, "compare-and-set on ad_videos flip-to-ready");
  const updBody = canonicalUpdate.body as { status: string; static_jpg_url: string; meta: { storage_path: string; archetype: string; generated_by: string } };
  assert.equal(updBody.status, "ready");
  assert.equal(updBody.meta.storage_path, "finals/ws-1/video-canonical.jpg");
  assert.equal(updBody.static_jpg_url, "signed://finals/ws-1/video-canonical.jpg");
});

test("landOverlayCreativePack: sibling ad_videos point at canonical via format_variant_of_id (same-psychology invariant)", async () => {
  const { admin, calls } = makeFakeAdmin({
    selectReturns: { product_ad_angles: { metadata: null } },
    insertReturns: {
      ad_videos: [{ id: "video-canonical" }, { id: "video-stories" }, { id: "video-right" }],
    },
  });
  const { storage } = makeFakeStorage();
  const res = await landOverlayCreativePack(admin as never, {
    workspaceId: "ws-1",
    campaignId: "campaign-1",
    angleId: "angle-1",
    canonicalRender: makeRender("feed_4x5"),
    siblingRenders: [makeRender("stories_9x16"), makeRender("right_column_1x1")],
    copyPack: makeCopyPack(),
    storage,
  });
  assert.deepEqual(res.siblingAdVideoIds, ["video-stories", "video-right"]);
  const siblingInserts = calls.filter((c) => c.op === "insert" && c.table === "ad_videos" && (c.body as { format?: string }).format !== "feed_4x5");
  assert.equal(siblingInserts.length, 2);
  for (const s of siblingInserts) {
    assert.equal((s.body as { format_variant_of_id: string }).format_variant_of_id, "video-canonical", "sibling points at the canonical ad_videos row");
  }
});

test("landOverlayCreativePack: writes temperature-banded variants to ad_creative_copy_variants when supplied", async () => {
  const { admin, calls } = makeFakeAdmin({
    selectReturns: { product_ad_angles: { metadata: null } },
    insertReturns: { ad_videos: [{ id: "v1" }, { id: "v2" }, { id: "v3" }] },
    upsertReturns: { ad_creative_copy_variants: [[{ id: "cv-1" }, { id: "cv-2" }]] },
  });
  const { storage } = makeFakeStorage();
  const variants: AuthorModeCopyVariant[] = [
    { audience_temperature: "cold", headline: "H-cold", primaryText: "P-cold", description: "D", selfScore: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] }, claim_trace: [], concept_tag: "curiosity", validatorPass: true, validatorChecks: [] },
    { audience_temperature: "warm", headline: "H-warm", primaryText: "P-warm", description: "D", selfScore: { lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total: 10, evidence: [] }, claim_trace: [], concept_tag: "curiosity", validatorPass: true, validatorChecks: [] },
  ];
  const res = await landOverlayCreativePack(admin as never, {
    workspaceId: "ws-1",
    campaignId: "campaign-1",
    angleId: "angle-1",
    canonicalRender: makeRender("feed_4x5"),
    siblingRenders: [makeRender("stories_9x16"), makeRender("right_column_1x1")],
    copyPack: makeCopyPack(),
    variants,
    storage,
  });
  assert.equal(res.copyVariantsWritten, 2);
  const upsert = calls.find((c) => c.op === "upsert" && c.table === "ad_creative_copy_variants");
  assert.ok(upsert);
  assert.equal(upsert.upsertOpts?.onConflict, "ad_campaign_id,audience_temperature", "upserts on the unique key");
});

test("landOverlayCreativePack: with no angleId, angle write is skipped and only ad_videos land (angleCopyPackWritten=false)", async () => {
  const { admin, calls } = makeFakeAdmin({
    insertReturns: { ad_videos: [{ id: "v1" }, { id: "v2" }, { id: "v3" }] },
  });
  const { storage } = makeFakeStorage();
  const res = await landOverlayCreativePack(admin as never, {
    workspaceId: "ws-1",
    campaignId: "campaign-1",
    angleId: null,
    canonicalRender: makeRender("feed_4x5"),
    siblingRenders: [makeRender("stories_9x16"), makeRender("right_column_1x1")],
    copyPack: makeCopyPack(),
    storage,
  });
  assert.equal(res.angleCopyPackWritten, false);
  assert.equal(calls.filter((c) => c.table === "product_ad_angles").length, 0, "no product_ad_angles read/write when angleId is null");
});

test("landOverlayCreativePack: png render uploads with `.png` extension + `image/png` contentType", async () => {
  const { admin } = makeFakeAdmin({
    selectReturns: { product_ad_angles: { metadata: null } },
    insertReturns: { ad_videos: [{ id: "vpng" }, { id: "vs" }, { id: "vr" }] },
  });
  const { storage, uploads } = makeFakeStorage();
  await landOverlayCreativePack(admin as never, {
    workspaceId: "ws-1",
    campaignId: "campaign-1",
    angleId: "angle-1",
    canonicalRender: makeRender("feed_4x5", "image/png"),
    siblingRenders: [makeRender("stories_9x16"), makeRender("right_column_1x1")],
    copyPack: makeCopyPack(),
    storage,
  });
  assert.deepEqual(uploads[0], { path: "finals/ws-1/vpng.png", contentType: "image/png" });
});
