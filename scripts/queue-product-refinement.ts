/**
 * queue-product-refinement — enqueue a box `product-seed` job in `refinement` mode
 * (the pdp-refinement-pass per-product run) for one already-published product.
 *
 * The seed API route (POST .../products/{id}/seed) only enqueues a plain none→published
 * seed; it carries no `mode`. The refinement / media-refresh / content-refresh modes are
 * read from `instructions.mode` by the box worker (scripts/builder-worker.ts → runProductSeedJob)
 * but no UI/CLI path produces a refinement job — this is that trigger. Used to run
 * pdp-refinement-pass P2 (Superfood Tabs) and P3 fan-out (one product at a time).
 *
 *   npx tsx scripts/queue-product-refinement.ts                 # default: Superfood Tabs
 *   npx tsx scripts/queue-product-refinement.ts <handle|title|uuid>
 *
 * The box worker claims kind='product-seed', reads the founder-LOCKED Tabs inputs from
 * docs/brain/specs/pdp-refinement-pass.md, and runs the full pass on Max (mutates prod
 * DB + storage). Run on the box (worker host) or locally with prod creds in .env.local.
 * See docs/brain/specs/pdp-refinement-pass.md + docs/brain/recipes/manage-the-build-queue.md.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

(async () => {
  // Default target = pdp-refinement-pass P2 (the source product). Override with argv[3].
  const target = (process.argv[2] || "superfood-tabs").trim();
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const a = createAdminClient();

  const { data: ws } = await a.from("workspaces").select("id,name");
  const sf = (ws || []).find((w: { name: string }) => /superfood/i.test(w.name)) || (ws || [])[0];
  if (!sf?.id) throw new Error("no Superfoods workspace found");

  // Resolve the product by uuid → exact handle → title ilike, scoped to the workspace.
  let product: { id: string; title: string; handle: string } | null = null;
  if (UUID_RE.test(target)) {
    const { data } = await a.from("products").select("id,title,handle").eq("workspace_id", sf.id).eq("id", target).maybeSingle();
    product = data;
  }
  if (!product) {
    const { data } = await a.from("products").select("id,title,handle").eq("workspace_id", sf.id).eq("handle", target).maybeSingle();
    product = data;
  }
  if (!product) {
    const { data } = await a.from("products").select("id,title,handle").eq("workspace_id", sf.id).ilike("title", `%${target}%`).limit(2);
    if ((data || []).length > 1) throw new Error(`"${target}" matched ${data!.length} products by title — pass an exact handle or uuid`);
    product = (data || [])[0] || null;
  }
  if (!product) throw new Error(`no product matched "${target}" in workspace ${sf.name}`);

  // Don't double-queue: reuse an in-flight product-seed job for this product if present.
  const { data: existing } = await a
    .from("agent_jobs")
    .select("id,status")
    .eq("workspace_id", sf.id)
    .eq("kind", "product-seed")
    .eq("spec_slug", product.id)
    .in("status", ["queued", "queued_resume", "building", "claimed"])
    .maybeSingle();
  if (existing) {
    console.log(`ALREADY IN-FLIGHT: job ${existing.id} (${existing.status}) for ${product.title} (${product.id})`);
    return;
  }

  const { data: job, error } = await a
    .from("agent_jobs")
    .insert({
      workspace_id: sf.id,
      spec_slug: product.id,
      kind: "product-seed",
      status: "queued",
      instructions: JSON.stringify({ product_id: product.id, workspace_id: sf.id, mode: "refinement" }),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  console.log(`QUEUED refinement pass: job ${job.id} for ${product.title} (${product.id}) in ${sf.name}`);
})();
