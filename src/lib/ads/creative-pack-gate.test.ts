/**
 * Unit tests for `evaluateCreativePackGate` — bianca-publishes-3-placement-multi-
 * copy-via-placement-customization Phase 3 verification.
 *
 * The gate is the publisher's pre-flight refusal: a Dahlia-authored static campaign
 * whose pack is INCOMPLETE (missing a placement static or <4 copy) MUST be
 * REFUSED — no degraded 1-image / <4-copy ad ships. Video / non-Dahlia campaigns
 * are `skipped` (the legacy publish paths keep running).
 *
 * Verification bullet ⇒ tests:
 *   "the gate refuses a publish whose creative lacks the 3 placement statics or
 *    <4 headlines/primary texts (with a diagnosable reason) and allows a complete
 *    pack."
 *
 * Run:  npx tsx --test src/lib/ads/creative-pack-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCreativePackGate, missingCreativePackDiagnosis, MISSING_CREATIVE_PACK_REASON } from "./creative-pack-gate";
import type { CreativePackSnapshot, PackAdVideoLike } from "@/lib/ads/creative-pack";

const CANONICAL_ID = "canon-uuid";

function readyStatic(fmt: string, format_variant_of_id: string | null = CANONICAL_ID): PackAdVideoLike {
  return { format: fmt, media_kind: "static", status: "ready", format_variant_of_id };
}

function completeSnapshot(overrides?: Partial<CreativePackSnapshot>): CreativePackSnapshot {
  return {
    adVideos: [
      readyStatic("feed_4x5", null),
      readyStatic("stories_9x16"),
      readyStatic("right_column_1x1"),
    ],
    canonicalId: CANONICAL_ID,
    angleMetadata: {
      copy_pack: {
        headlines: ["h1", "h2", "h3", "h4"],
        primaryTexts: ["p1", "p2", "p3", "p4"],
      },
    },
    ...overrides,
  };
}

test("evaluateCreativePackGate — complete pack ⇒ allowed", () => {
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot: completeSnapshot() });
  assert.equal(v.allowed, true);
});

test("evaluateCreativePackGate — video mediaKind ⇒ skipped:not_static (legacy video path untouched)", () => {
  const v = evaluateCreativePackGate({ mediaKind: "video", snapshot: completeSnapshot() });
  assert.equal(v.allowed, true);
  if (!v.allowed) throw new Error("unreachable");
  assert.equal(v.skipped, "not_static");
});

test("evaluateCreativePackGate — no feed_4x5 canonical ⇒ skipped:no_dahlia_pack (legacy studio path untouched)", () => {
  const snapshot = completeSnapshot({
    adVideos: [
      // Legacy campaign with just an image ad — no feed_4x5 canonical row Dahlia writes.
      { format: "square_1x1", media_kind: "static", status: "ready", format_variant_of_id: null },
    ],
    canonicalId: null,
  });
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot });
  assert.equal(v.allowed, true);
  if (!v.allowed) throw new Error("unreachable");
  assert.equal(v.skipped, "no_dahlia_pack");
});

test("evaluateCreativePackGate — canonical pending ⇒ REFUSE with packReason:canonical_not_ready", () => {
  const snapshot = completeSnapshot({
    adVideos: [
      { format: "feed_4x5", media_kind: "static", status: "pending", format_variant_of_id: null },
      readyStatic("stories_9x16"),
      readyStatic("right_column_1x1"),
    ],
  });
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot });
  assert.equal(v.allowed, false);
  if (v.allowed) throw new Error("unreachable");
  assert.equal(v.reason, MISSING_CREATIVE_PACK_REASON);
  assert.equal(v.packReason, "canonical_not_ready");
  assert.match(v.detail, /canonical feed_4x5 is/);
});

test("evaluateCreativePackGate — missing 9:16 sibling ⇒ REFUSE with packReason:missing_9x16_sibling", () => {
  const snapshot = completeSnapshot({
    adVideos: [
      readyStatic("feed_4x5", null),
      readyStatic("right_column_1x1"),
    ],
  });
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot });
  assert.equal(v.allowed, false);
  if (v.allowed) throw new Error("unreachable");
  assert.equal(v.packReason, "missing_9x16_sibling");
});

test("evaluateCreativePackGate — missing right_column_1x1 sibling ⇒ REFUSE (no degraded 2-bucket ship)", () => {
  const snapshot = completeSnapshot({
    adVideos: [
      readyStatic("feed_4x5", null),
      readyStatic("stories_9x16"),
    ],
  });
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot });
  assert.equal(v.allowed, false);
  if (v.allowed) throw new Error("unreachable");
  assert.equal(v.packReason, "missing_right_column_1x1_sibling");
});

test("evaluateCreativePackGate — <4 headlines ⇒ REFUSE (no 1-copy ship)", () => {
  const snapshot = completeSnapshot({
    angleMetadata: {
      copy_pack: {
        headlines: ["h1", "h2", "h3"],
        primaryTexts: ["p1", "p2", "p3", "p4"],
      },
    },
  });
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot });
  assert.equal(v.allowed, false);
  if (v.allowed) throw new Error("unreachable");
  assert.equal(v.packReason, "headlines_below_min");
});

test("evaluateCreativePackGate — <4 primary texts ⇒ REFUSE (no 1-copy ship)", () => {
  const snapshot = completeSnapshot({
    angleMetadata: {
      copy_pack: {
        headlines: ["h1", "h2", "h3", "h4"],
        primaryTexts: ["p1", "p2", "p3"],
      },
    },
  });
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot });
  assert.equal(v.allowed, false);
  if (v.allowed) throw new Error("unreachable");
  assert.equal(v.packReason, "primary_texts_below_min");
});

test("evaluateCreativePackGate — copy_pack missing entirely ⇒ REFUSE with packReason:copy_pack_missing", () => {
  const snapshot = completeSnapshot({ angleMetadata: null });
  const v = evaluateCreativePackGate({ mediaKind: "static", snapshot });
  assert.equal(v.allowed, false);
  if (v.allowed) throw new Error("unreachable");
  assert.equal(v.packReason, "copy_pack_missing");
});

test("missingCreativePackDiagnosis — names the campaign + pack reason + why 1-image is fatal", () => {
  const diagnosis = missingCreativePackDiagnosis({
    packReason: "missing_right_column_1x1_sibling",
    detail: "no right_column_1x1 sibling",
    campaignId: "camp-42",
  });
  assert.match(diagnosis, /camp-42/, "diagnosis names the campaign");
  assert.match(diagnosis, /missing_right_column_1x1_sibling/, "diagnosis names the pack reason");
  assert.match(diagnosis, /Publishing NOTHING/i, "diagnosis states the refusal (not a fall-through)");
  assert.match(diagnosis, /3-placement/, "diagnosis names the 3-placement benefit that would be lost");
});
