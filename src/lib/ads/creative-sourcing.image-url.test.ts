/** Competitor-angle imageUrl must be fetchable image bytes, never the Meta render_ad HTML page
 *  (the daily ad-creative failure since 2026-11-16: Gemini 400 "Unable to process input image"). */
import test from "node:test";
import assert from "node:assert/strict";
import { directImageUrl, getCompetitorAngleBySkeletonId, mapRowToCompetitorAngle } from "./creative-sourcing";
import type { createAdminClient } from "@/lib/supabase/admin";

const RENDER_AD = "https://www.facebook.com/ads/archive/render_ad/?id=123&access_token=abc";

test("directImageUrl drops the Meta render_ad HTML snapshot", () => {
  assert.equal(directImageUrl(RENDER_AD), null);
  assert.equal(directImageUrl("https://cdn.example/ad.jpg"), "https://cdn.example/ad.jpg");
  assert.equal(directImageUrl(null), null);
  assert.equal(directImageUrl(""), null);
});

test("mapRowToCompetitorAngle never surfaces a render_ad URL as imageUrl", () => {
  assert.equal(mapRowToCompetitorAngle({ image_url: RENDER_AD }).imageUrl, null);
});

function fakeAdmin(row: Record<string, unknown>, signed: string | null) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: row, error: null });
  return {
    from: () => q,
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          assert.equal(bucket, "creative-shots");
          assert.equal(path, "ws/shot.jpg");
          return signed ? { data: { signedUrl: signed }, error: null } : { data: null, error: { message: "x" } };
        },
      }),
    },
  } as unknown as ReturnType<typeof createAdminClient>;
}

test("pinned-ad reader signs thumb_path into imageUrl", async () => {
  const a = await getCompetitorAngleBySkeletonId(
    fakeAdmin({ image_url: RENDER_AD, thumb_path: "ws/shot.jpg" }, "https://storage.example/signed.jpg"),
    "ws",
    "id",
  );
  assert.equal(a?.imageUrl, "https://storage.example/signed.jpg");
});

test("signing failure leaves imageUrl null rather than the HTML page", async () => {
  const a = await getCompetitorAngleBySkeletonId(fakeAdmin({ image_url: RENDER_AD, thumb_path: "ws/shot.jpg" }, null), "ws", "id");
  assert.equal(a?.imageUrl, null);
});
