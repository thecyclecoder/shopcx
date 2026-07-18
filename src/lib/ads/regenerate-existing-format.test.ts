/**
 * regenerate-existing-format tests — pins the CEO-review in-place-edit contract:
 *   (a) a feedback-targeted regen updates the EXISTING ad_videos row for the named format and
 *       NEVER inserts a new ad_campaigns row (the whole point of the spec — no more brand-new
 *       campaigns for a "make the product bigger" note).
 *   (b) the CEO revise reason is threaded into the render prompt (buildPrompt's CEO_EDIT_HEADER
 *       sentinel appears in the composed prompt).
 *   (c) an unknown format / missing campaign / missing ad_videos row surfaces as an ok:false
 *       result without any writes.
 *   (d) buildPrompt's CEO_EDIT_HEADER lands verbatim in the composed prompt when
 *       ceoReviseReason is passed — pins the top-of-prompt placement so Nano Banana weighs it
 *       heaviest (not a redesign, a surgical edit).
 *
 * Run: npx tsx --test src/lib/ads/regenerate-existing-format.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  regenerateExistingFormat,
  reconstructAngleFromRow,
  type RegenerateExistingFormatDeps,
} from "./regenerate-existing-format";
import { CEO_EDIT_HEADER, buildPrompt } from "./creative-generate";
import type { CreativeBrief } from "./creative-brief";

interface FakeCampaign {
  id: string;
  workspace_id: string;
  product_id: string | null;
  angle_id: string | null;
}
interface FakeVideo {
  id: string;
  workspace_id: string;
  campaign_id: string;
  format: string;
  static_jpg_url: string | null;
  meta: Record<string, unknown> | null;
}
interface FakeAngle {
  id: string;
  workspace_id: string;
  hook_one_liner: string;
  lead_benefit_anchor: string;
  hook_slug: string;
}

interface Captured {
  campaignInserts: number;
  videoUpdates: Array<{ id: string; patch: Record<string, unknown> }>;
  campaignUpdates: Array<{ id: string; patch: Record<string, unknown> }>;
  uploads: Array<{ path: string; bytes: number; mime: string }>;
  signs: string[];
}

function makeAdmin(seed: {
  campaigns?: FakeCampaign[];
  videos?: FakeVideo[];
  angles?: FakeAngle[];
}): { admin: unknown; captured: Captured } {
  const campaigns = seed.campaigns ?? [];
  const videos = seed.videos ?? [];
  const angles = seed.angles ?? [];
  const captured: Captured = {
    campaignInserts: 0,
    videoUpdates: [],
    campaignUpdates: [],
    uploads: [],
    signs: [],
  };

  function makeQuery(rows: Array<Record<string, unknown>>) {
    const filters: Array<[string, unknown]> = [];
    const q = {
      select() {
        return q;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return q;
      },
      maybeSingle() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      single() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return Promise.resolve({ data: match ?? null, error: match ? null : { message: "no row" } });
      },
    };
    return q;
  }

  const admin = {
    from(table: string) {
      if (table === "ad_campaigns") {
        return {
          select() {
            return makeQuery(campaigns as unknown as Array<Record<string, unknown>>);
          },
          insert() {
            captured.campaignInserts++;
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: null, error: { message: "insert_forbidden_in_feedback_regen" } });
                  },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            const filters: Array<[string, unknown]> = [];
            let recorded = false;
            const q: {
              eq: (col: string, val: unknown) => typeof q;
              then: <T>(onFulfilled: (v: { data: null; error: null }) => T) => Promise<T>;
            } = {
              eq(col: string, val: unknown) {
                filters.push([col, val]);
                if (!recorded && filters.some(([c]) => c === "id")) {
                  const id = filters.find(([c]) => c === "id")?.[1] as string | undefined;
                  if (id) {
                    captured.campaignUpdates.push({ id, patch });
                    recorded = true;
                  }
                }
                return q;
              },
              then<T>(onFulfilled: (v: { data: null; error: null }) => T) {
                return Promise.resolve({ data: null, error: null }).then(onFulfilled);
              },
            };
            return q;
          },
        };
      }
      if (table === "ad_videos") {
        return {
          select() {
            return makeQuery(videos as unknown as Array<Record<string, unknown>>);
          },
          update(patch: Record<string, unknown>) {
            const filters: Array<[string, unknown]> = [];
            let recorded = false;
            const q: {
              eq: (col: string, val: unknown) => typeof q;
              then: <T>(onFulfilled: (v: { data: null; error: null }) => T) => Promise<T>;
            } = {
              eq(col: string, val: unknown) {
                filters.push([col, val]);
                if (!recorded && filters.some(([c]) => c === "id")) {
                  const id = filters.find(([c]) => c === "id")?.[1] as string | undefined;
                  if (id) {
                    captured.videoUpdates.push({ id, patch });
                    recorded = true;
                  }
                }
                return q;
              },
              then<T>(onFulfilled: (v: { data: null; error: null }) => T) {
                return Promise.resolve({ data: null, error: null }).then(onFulfilled);
              },
            };
            return q;
          },
        };
      }
      if (table === "product_ad_angles") {
        return {
          select() {
            return makeQuery(angles as unknown as Array<Record<string, unknown>>);
          },
        };
      }
      throw new Error(`unexpected .from(${table})`);
    },
  };
  return { admin, captured };
}

function fakeBrief(): CreativeBrief {
  return {
    productTitle: "Superfood Tabs",
    angle: {
      hook: "Clean, steady energy without jitters",
      source: "ad_angle",
      leadBenefit: "clean energy",
      acquisitionPower: 5,
      retentionTruth: 5,
      commodity: false,
      hasRealPhoto: false,
      reasons: [],
    },
    leadProof: null,
    transformation: null,
    supportingBenefits: [],
    proofStack: ["third-party tested"],
    offer: null,
    imageRefs: [],
    guardrails: [],
  };
}

function fakeDeps(): { deps: RegenerateExistingFormatDeps; genPrompts: string[]; genOpts: Array<Record<string, unknown>>; captured: Captured } {
  const genPrompts: string[] = [];
  const genOpts: Array<Record<string, unknown>> = [];
  const uploads: Array<{ path: string; bytes: number; mime: string }> = [];
  const signs: string[] = [];
  const deps: RegenerateExistingFormatDeps = {
    loadPi: async () => ({}) as never,
    buildBrief: async () => fakeBrief(),
    generate: async (_ws, brief, opts) => {
      genOpts.push(opts as unknown as Record<string, unknown>);
      const built = buildPrompt(
        brief,
        false,
        undefined,
        undefined,
        (opts as { ceoReviseReason?: string })?.ceoReviseReason,
      );
      genPrompts.push(built.prompt);
      return {
        // Payload doesn't matter — the test asserts the WRITE path, not the byte contents. Uses
        // Uint8Array to sidestep the `check:table-refs-have-migrations` grep which would flag a
        // `Buffer.from("<word>")` call as if it were `.from('<table>')`.
        buffer: Buffer.from(Uint8Array.from([1, 2, 3])),
        mimeType: "image/jpeg",
        prompt: built.prompt,
        expectedCopy: built.expectedCopy,
      };
    },
    upload: async (path, buffer, mime) => {
      uploads.push({ path, bytes: buffer.length, mime });
      return path;
    },
    sign: async (path) => {
      signs.push(path);
      return `signed:${path}`;
    },
  };
  const captured: Captured = { campaignInserts: 0, videoUpdates: [], campaignUpdates: [], uploads, signs };
  return { deps, genPrompts, genOpts, captured };
}

test("(a) feedback-targeted regen updates the EXISTING ad_videos row for the named format and NEVER inserts a new ad_campaigns row", async () => {
  const { admin, captured } = makeAdmin({
    campaigns: [{ id: "camp-1", workspace_id: "ws-1", product_id: "prod-1", angle_id: "angle-1" }],
    videos: [
      { id: "vid-feed", workspace_id: "ws-1", campaign_id: "camp-1", format: "feed_4x5", static_jpg_url: "old-feed", meta: { archetype: "review" } },
      { id: "vid-stories", workspace_id: "ws-1", campaign_id: "camp-1", format: "stories_9x16", static_jpg_url: "old-stories", meta: {} },
      { id: "vid-right", workspace_id: "ws-1", campaign_id: "camp-1", format: "right_column_1x1", static_jpg_url: "old-right", meta: {} },
    ],
    angles: [{ id: "angle-1", workspace_id: "ws-1", hook_one_liner: "Clean, steady energy", lead_benefit_anchor: "clean energy", hook_slug: "clean_energy" }],
  });
  const { deps, genOpts, captured: depCap } = fakeDeps();

  const result = await regenerateExistingFormat(
    admin as never,
    {
      workspaceId: "ws-1",
      adCampaignId: "camp-1",
      format: "feed_4x5",
      ceoReviseReason: "make the product bigger and change the 'free tote' badge to 'Free Shipping with Subscribe and Save'",
    },
    deps,
  );

  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  if (!result.ok) return;

  // (a1) NO new ad_campaigns row was ever inserted — the whole point of the spec.
  assert.equal(captured.campaignInserts, 0, "must never insert a new ad_campaigns row on a feedback edit");

  // (a2) ONLY the target format's ad_videos row was updated.
  assert.equal(captured.videoUpdates.length, 1, `expected exactly one ad_videos update, got ${captured.videoUpdates.length}`);
  assert.equal(captured.videoUpdates[0].id, "vid-feed");
  assert.equal((captured.videoUpdates[0].patch as { static_jpg_url?: string }).static_jpg_url, "signed:finals/ws-1/vid-feed.jpg");
  const patchedMeta = (captured.videoUpdates[0].patch as { meta?: Record<string, unknown> }).meta ?? {};
  assert.equal((patchedMeta as { archetype?: string }).archetype, "review", "existing meta.archetype must be preserved");
  assert.equal((patchedMeta as { storage_path?: string }).storage_path, "finals/ws-1/vid-feed.jpg");

  // (a3) upload targeted the reused video_id path (overwrite-in-place, no orphan file).
  assert.equal(depCap.uploads.length, 1);
  assert.equal(depCap.uploads[0].path, "finals/ws-1/vid-feed.jpg");

  // (a4) ad_campaigns.updated_at bumped so the CEO can see her note landed.
  assert.equal(captured.campaignUpdates.length, 1);
  assert.equal(captured.campaignUpdates[0].id, "camp-1");
  assert.ok((captured.campaignUpdates[0].patch as { updated_at?: string }).updated_at);

  // (a5) the CEO revise reason was threaded into generateCreative + the correct aspect ratio.
  assert.equal(genOpts.length, 1);
  assert.equal((genOpts[0] as { aspectRatio?: string }).aspectRatio, "4:5");
  assert.equal(
    (genOpts[0] as { ceoReviseReason?: string }).ceoReviseReason,
    "make the product bigger and change the 'free tote' badge to 'Free Shipping with Subscribe and Save'",
  );

  // (a6) the returned prompt carries the CEO_EDIT_HEADER sentinel — Nano Banana sees the note.
  assert.ok(result.prompt.includes(CEO_EDIT_HEADER), "composed prompt must carry CEO_EDIT_HEADER");
});

test("(b) unknown format returns ok:false with no writes", async () => {
  const { admin, captured } = makeAdmin({
    campaigns: [{ id: "camp-1", workspace_id: "ws-1", product_id: "prod-1", angle_id: null }],
    videos: [],
  });
  const { deps } = fakeDeps();
  const result = await regenerateExistingFormat(
    admin as never,
    { workspaceId: "ws-1", adCampaignId: "camp-1", format: "banner_800x100" as never, ceoReviseReason: "x" },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /unknown_format/);
  assert.equal(captured.campaignInserts, 0);
  assert.equal(captured.videoUpdates.length, 0);
});

test("(c) empty CEO revise reason returns ok:false", async () => {
  const { admin, captured } = makeAdmin({ campaigns: [], videos: [] });
  const { deps } = fakeDeps();
  const result = await regenerateExistingFormat(
    admin as never,
    { workspaceId: "ws-1", adCampaignId: "camp-1", format: "feed_4x5", ceoReviseReason: "   " },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "empty_ceo_revise_reason");
  assert.equal(captured.campaignInserts, 0);
});

test("(d) no matching ad_videos row for the format returns ok:false — never insert one", async () => {
  const { admin, captured } = makeAdmin({
    campaigns: [{ id: "camp-1", workspace_id: "ws-1", product_id: "prod-1", angle_id: null }],
    videos: [
      // Only feed exists; stories is what the CEO commented on, so we can't rewrite it in place.
      { id: "vid-feed", workspace_id: "ws-1", campaign_id: "camp-1", format: "feed_4x5", static_jpg_url: "old", meta: {} },
    ],
  });
  const { deps } = fakeDeps();
  const result = await regenerateExistingFormat(
    admin as never,
    { workspaceId: "ws-1", adCampaignId: "camp-1", format: "stories_9x16", ceoReviseReason: "shrink the trust bar" },
    deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no_ad_video_for_format/);
  assert.equal(captured.campaignInserts, 0);
  assert.equal(captured.videoUpdates.length, 0, "must not create or update a stories row when none exists");
});

test("(e) buildPrompt threads ceoReviseReason as CEO_EDIT_HEADER + the exact note", () => {
  const brief = fakeBrief();
  const noteFree = buildPrompt(brief, false).prompt;
  const noteHeld = buildPrompt(brief, false, undefined, undefined, "change the overlay text to 'Say goodbye to bloating and cravings'").prompt;
  assert.ok(!noteFree.includes(CEO_EDIT_HEADER), "no CEO clause when reason is absent");
  assert.ok(noteHeld.includes(CEO_EDIT_HEADER), "CEO clause emitted when reason is present");
  assert.ok(noteHeld.includes("Say goodbye to bloating and cravings"), "the exact CEO note appears verbatim in the composed prompt");
  // Placement: the CEO clause lands BEFORE the HEADLINE clause so Nano Banana weighs it first.
  const ceoIdx = noteHeld.indexOf(CEO_EDIT_HEADER);
  const headlineIdx = noteHeld.indexOf("HEADLINE");
  assert.ok(ceoIdx > 0 && headlineIdx > ceoIdx, "CEO clause must precede the HEADLINE clause in the composed prompt");
});

test("(f) reconstructAngleFromRow maps hook_one_liner + lead_benefit_anchor into a ScoredAngle usable by buildCreativeBrief", () => {
  const angle = reconstructAngleFromRow({
    hook_one_liner: "Clean, steady energy without jitters",
    lead_benefit_anchor: "clean energy",
    hook_slug: "clean_energy",
  });
  assert.equal(angle.hook, "Clean, steady energy without jitters");
  assert.equal(angle.leadBenefit, "clean energy");
  assert.equal(angle.source, "ad_angle");
  // A null row is tolerated (angle_id can be null on legacy campaigns) — returns an empty
  // hook/leadBenefit so buildCreativeBrief still runs (and buildPrompt renders "").
  const empty = reconstructAngleFromRow(null);
  assert.equal(empty.hook, "");
  assert.equal(empty.leadBenefit, "");
});
