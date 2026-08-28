/**
 * Fire the real `ads/creative-scout.sweep` Inngest event — the same path the weekly cron takes,
 * one week early. Exercises the piece the direct-runner tests skipped: the Vercel Inngest fn →
 * agent_jobs enqueue → box claim lane → runCreativeScoutJob wrapper.
 */
import "./_bootstrap";
import { inngest } from "../src/lib/inngest/client";

async function main() {
  const workspaceId = process.env.WORKSPACE;
  const productId = process.env.PRODUCT || undefined;
  if (!workspaceId) throw new Error("set WORKSPACE=");

  const r = await inngest.send({
    name: "ads/creative-scout.sweep",
    data: { workspaceId, ...(productId ? { productId } : {}), force: true },
  });
  console.log(`sent ads/creative-scout.sweep · ids=${JSON.stringify(r.ids)}`);
  console.log(`  workspace ${workspaceId}${productId ? ` · product ${productId}` : " · ALL products"} · force=true`);
}
main().catch((e) => { console.error(e); process.exit(1); });
