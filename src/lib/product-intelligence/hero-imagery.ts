/**
 * Nano Banana Pro hero/lifestyle/ingredient imagery (box-product-seeding step 6).
 *
 * Per product/variant, the box generates the HERO by feeding Nano Banana Pro:
 *   (a) the isolated front-facing packshot (product identity — from Drive
 *       `{Product}/Isolated Product Shots`, resolved via google-drive.ts),
 *   (b) the proven `Hero Example` reference set (composition/style), and
 *   (c) the product's ingredients + flavor.
 *
 * Locked composition (white bg, contained flavor splash, front pack centered,
 * the prepared drink in a glass — hot latte for coffee/creamer, iced tall glass
 * for everything else, real-ingredient cluster + flavor element). The box then
 * VISION-CONFIRMS the result before it is kept.
 *
 * 🔒 Never overwrite an approved hero. Image generation is SKIPPED entirely for
 * the locked products (Amazing Coffee, Amazing Coffee pods/K-Cups, Amazing
 * Creamer), and is idempotent (skips any product that already has a hero row).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { generateNanoBananaProCombine } from "@/lib/gemini";
import { callSonnetVision, extractJson } from "./engine";
import { DriveClient, resolveProductShots, HERO_EXAMPLE_FOLDER_ID, type DriveFile } from "@/lib/google-drive";

type Admin = ReturnType<typeof createAdminClient>;

export const PRODUCT_MEDIA_BUCKET = "product-media";

// Handles whose heroes are already perfect + locked — skip image gen entirely.
// (They may still receive non-image intelligence: research/reviews/content.)
export const LOCKED_HERO_HANDLES = new Set(["amazing-coffee", "amazing-coffee-pods", "amazing-creamer"]);

export type HeroResult =
  | { status: "skipped"; reason: string }
  | { status: "generated"; slot: string; url: string; vision: VisionVerdict }
  | { status: "failed"; reason: string; vision?: VisionVerdict };

export type VisionVerdict = {
  pass: boolean;
  correct_variant: boolean;
  contained_splash: boolean;
  correct_drink: boolean;
  no_edge_cutoffs: boolean;
  issues: string[];
};

function publicUrl(admin: Admin, path: string): string {
  return admin.storage.from(PRODUCT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function uploadImage(admin: Admin, path: string, buffer: Buffer, contentType: string): Promise<string> {
  const { error } = await admin.storage.from(PRODUCT_MEDIA_BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`product_media_upload: ${error.message}`);
  return publicUrl(admin, path);
}

/** True when the product already has a hero media row with a URL — don't overwrite. */
export async function hasApprovedHero(admin: Admin, workspace_id: string, product_id: string): Promise<boolean> {
  const { data } = await admin
    .from("product_media")
    .select("slot, url")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .eq("slot", "hero")
    .not("url", "is", null)
    .maybeSingle();
  return !!data?.url;
}

function buildHeroPrompt(args: {
  productTitle: string;
  ingredients: string[];
  flavor: string | null;
  isCoffeeOrCreamer: boolean;
}): string {
  const { productTitle, ingredients, flavor, isCoffeeOrCreamer } = args;
  const drink = isCoffeeOrCreamer
    ? "a hot latte / cappuccino in a clear glass mug"
    : `a refreshing ICED drink in a TALL clear glass, colored to the ${flavor || "product"} flavor`;
  const splash = flavor ? `${flavor}-colored powder/dust` : "flavor-colored powder/dust";
  return `Create a premium product hero image for "${productTitle}".

Use the FIRST image as the exact product package identity (match its label, colors and text precisely — this is a real product, do not redesign the packaging). Use the remaining reference image(s) ONLY for composition and lighting style.

LOCKED composition:
- Clean WHITE background.
- A ${splash} splash BEHIND the package that stays fully INSIDE the frame — no edge cutoffs, so it sits cleanly on white.
- The front-facing package centered and sharp.
- ${drink} beside the package.
- A small cluster of the real superfood ingredients at the base: ${ingredients.slice(0, 8).join(", ") || "the product's ingredients"}${flavor ? `, plus the ${flavor} flavor element` : ""}.

Photorealistic, studio product photography, soft natural light, crisp focus on the package. Single variant only — do not show multiple flavors.`;
}

async function visionConfirmHero(
  heroUrl: string,
  buffer: Buffer,
  mimeType: string,
  expect: { variant: string | null; isCoffeeOrCreamer: boolean },
): Promise<VisionVerdict> {
  const system = "You are a meticulous product-photography QA reviewer. Respond with strict JSON only — no prose, no markdown fences.";
  const drinkExpect = expect.isCoffeeOrCreamer ? "a HOT latte/cappuccino in a clear glass mug" : "an ICED drink in a TALL clear glass";
  const user = `Check this generated product hero against the locked pattern. Return JSON:
{
  "correct_variant": boolean,      // shows the right single variant${expect.variant ? ` (expected: ${expect.variant})` : ""}, not multiple flavors
  "contained_splash": boolean,     // the colored powder/dust splash is fully inside the frame on white (no splash bleeding off the edges)
  "correct_drink": boolean,        // the prepared drink is ${drinkExpect}
  "no_edge_cutoffs": boolean,      // nothing important is cut off by the frame edges; background is clean white
  "issues": ["short strings describing any problem; empty if all good"]
}`;
  const base64 = buffer.toString("base64");
  const resp = await callSonnetVision(system, user, [{ mediaType: mimeType, base64 }], 1024, 0);
  const v = extractJson<Omit<VisionVerdict, "pass">>(resp?.text || "");
  const verdict: VisionVerdict = {
    correct_variant: !!v?.correct_variant,
    contained_splash: !!v?.contained_splash,
    correct_drink: !!v?.correct_drink,
    no_edge_cutoffs: !!v?.no_edge_cutoffs,
    issues: Array.isArray(v?.issues) ? v!.issues : [],
    pass: false,
  };
  verdict.pass = verdict.correct_variant && verdict.contained_splash && verdict.correct_drink && verdict.no_edge_cutoffs;
  void heroUrl;
  return verdict;
}

/**
 * Generate + QA the hero for one product/variant. Idempotent + locked-aware.
 * On QA pass, writes a `product_media` row (slot='hero') and returns its URL.
 * On QA fail (after one retry), returns status:"failed" and writes nothing —
 * the seed pipeline holds the product rather than publishing a bad hero.
 */
export async function generateHero(
  admin: Admin,
  args: {
    workspace_id: string;
    product_id: string;
    handle: string | null;
    productTitle: string;
    ingredients: string[];
    flavor: string | null;
    variantKeywords: string[];
    isCoffeeOrCreamer: boolean;
  },
): Promise<HeroResult> {
  const { workspace_id, product_id, handle, productTitle, ingredients, flavor, variantKeywords, isCoffeeOrCreamer } = args;

  if (handle && LOCKED_HERO_HANDLES.has(handle)) return { status: "skipped", reason: "locked hero (approved) — image gen skipped" };
  if (await hasApprovedHero(admin, workspace_id, product_id)) return { status: "skipped", reason: "hero already exists — not overwritten" };

  const drive = await DriveClient.forWorkspace(workspace_id);
  if (!drive) return { status: "failed", reason: "google_drive_not_connected (workspace SA key missing)" };

  // (a) the isolated front-facing packshot.
  const candidates = await resolveProductShots(drive, { productName: productTitle, variantKeywords, preferBag: true });
  if (candidates.length === 0) return { status: "failed", reason: `no isolated packshot found in Drive for "${productTitle}"` };
  const packshot = await drive.download(candidates[0].id);
  if (!packshot) return { status: "failed", reason: "packshot download failed" };
  const packUrl = await uploadImage(admin, `_seed/${product_id}/packshot-${candidates[0].id}.png`, packshot.buffer, packshot.mimeType);

  // (b) the Hero Example reference set (take up to 2 for style).
  const refUrls: string[] = [];
  const refs: DriveFile[] = (await drive.listImagesInFolder(HERO_EXAMPLE_FOLDER_ID)).slice(0, 2);
  for (const ref of refs) {
    const dl = await drive.download(ref.id);
    if (dl) refUrls.push(await uploadImage(admin, `_seed/${product_id}/ref-${ref.id}.png`, dl.buffer, dl.mimeType));
  }

  const prompt = buildHeroPrompt({ productTitle, ingredients, flavor, isCoffeeOrCreamer });

  // Generate → vision-confirm. One retry on QA fail.
  let lastVerdict: VisionVerdict | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let gen: { buffer: Buffer; mimeType: string };
    try {
      gen = await generateNanoBananaProCombine({
        workspaceId: workspace_id,
        prompt: attempt === 0 ? prompt : `${prompt}\n\nFix these issues from the previous attempt: ${(lastVerdict?.issues || []).join("; ")}`,
        imageUrls: [packUrl, ...refUrls],
        aspectRatio: "1:1",
      });
    } catch (e) {
      return { status: "failed", reason: `nano_banana: ${e instanceof Error ? e.message : String(e)}` };
    }
    const verdict = await visionConfirmHero("", gen.buffer, gen.mimeType, { variant: variantKeywords[0] || flavor, isCoffeeOrCreamer });
    lastVerdict = verdict;
    if (!verdict.pass) continue;

    const heroPath = `${product_id}/hero.png`;
    const url = await uploadImage(admin, heroPath, gen.buffer, gen.mimeType);
    await admin.from("product_media").upsert(
      {
        workspace_id,
        product_id,
        slot: "hero",
        display_order: 0,
        url,
        storage_path: heroPath,
        alt_text: `${productTitle} — hero`,
        mime_type: gen.mimeType,
        uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,product_id,slot,display_order" },
    );

    // Lifestyle + ingredient-callout images in the same style (best-effort — not
    // QA-gated; only the hero is locked). A failure here never holds publishing.
    await generateSupportingImagery(admin, {
      workspace_id,
      product_id,
      productTitle,
      ingredients,
      flavor,
      packUrl,
      refUrls,
    }).catch((e) => console.error("[hero] supporting imagery failed (non-fatal):", e instanceof Error ? e.message : e));

    return { status: "generated", slot: "hero", url, vision: verdict };
  }

  return { status: "failed", reason: `hero failed vision QA: ${(lastVerdict?.issues || []).join("; ")}`, vision: lastVerdict };
}

/**
 * Lifestyle + ingredient-callout images in the same style as the hero. Reuses
 * the resolved packshot + Hero Example refs. Best-effort — each is upserted to
 * its own product_media slot; failures are swallowed by the caller.
 */
async function generateSupportingImagery(
  admin: Admin,
  args: {
    workspace_id: string;
    product_id: string;
    productTitle: string;
    ingredients: string[];
    flavor: string | null;
    packUrl: string;
    refUrls: string[];
  },
): Promise<void> {
  const { workspace_id, product_id, productTitle, ingredients, flavor, packUrl, refUrls } = args;
  const flavorPart = flavor ? ` Flavor accent: ${flavor}.` : "";
  const shots: Array<{ slot: string; prompt: string }> = [
    {
      slot: "lifestyle",
      prompt: `A warm, bright lifestyle scene featuring "${productTitle}" (use the FIRST image as the exact package identity — do not redesign it). The product sits naturally on a clean kitchen counter with soft morning light, prepared drink nearby. Photorealistic, premium, inviting.${flavorPart}`,
    },
    {
      slot: "ingredient",
      prompt: `A clean ingredient-callout image for "${productTitle}" (use the FIRST image as the exact package identity). The package centered on white, surrounded by a tidy arrangement of the real superfood ingredients: ${ingredients.slice(0, 8).join(", ") || "the product's ingredients"}. Studio product photography, crisp focus.${flavorPart}`,
    },
  ];
  for (const shot of shots) {
    try {
      const gen = await generateNanoBananaProCombine({
        workspaceId: workspace_id,
        prompt: shot.prompt,
        imageUrls: [packUrl, ...refUrls],
        aspectRatio: "1:1",
      });
      const path = `${product_id}/${shot.slot}.png`;
      const url = await uploadImage(admin, path, gen.buffer, gen.mimeType);
      await admin.from("product_media").upsert(
        {
          workspace_id,
          product_id,
          slot: shot.slot,
          display_order: 0,
          url,
          storage_path: path,
          alt_text: `${productTitle} — ${shot.slot}`,
          mime_type: gen.mimeType,
          uploaded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,product_id,slot,display_order" },
      );
    } catch (e) {
      console.error(`[hero] ${shot.slot} image failed (non-fatal):`, e instanceof Error ? e.message : e);
    }
  }
}
