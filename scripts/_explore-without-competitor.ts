/**
 * How many ads were made in EXPLORE mode with NO competitor base?
 * Explore/discover is supposed to model a proven competitor ad; competitor_hook=null means
 * Dahlia free-styled an own-brand angle instead. Measured, not estimated. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();

  const { data: angles, error } = await a.from("product_ad_angles")
    .select("id,product_id,metadata,created_at,is_active").eq("workspace_id", WS)
    .order("created_at", { ascending: false }).limit(1000);
  if (error) throw new Error(`product_ad_angles: ${error.message}`);

  const { data: prods } = await a.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  let explore = 0, exploreNoComp = 0, exploit = 0;
  const byProduct = new Map<string, { total: number; noComp: number; first: string; last: string }>();
  const examples: Array<{ id: string; product: string; when: string; source: string; lead: string }> = [];

  for (const ang of angles ?? []) {
    const m = (ang.metadata ?? {}) as Record<string, unknown>;
    const p = (m.provenance ?? {}) as Record<string, unknown>;
    if (!Object.keys(p).length) continue;
    const mode = String(p.mode ?? "");
    if (mode === "exploit") { exploit += 1; continue; }
    if (mode !== "explore") continue;
    explore += 1;
    const hasComp = Boolean(p.competitor_hook || p.competitor_advertiser);
    const pid = String(ang.product_id);
    const e = byProduct.get(pid) ?? { total: 0, noComp: 0, first: "", last: "" };
    e.total += 1;
    const when = String(ang.created_at).slice(0, 10);
    e.last = e.last || when; e.first = when;
    if (!hasComp) {
      exploreNoComp += 1; e.noComp += 1;
      if (examples.length < 14) {
        examples.push({ id: String(ang.id).slice(0, 8), product: title.get(pid) ?? "?", when, source: String(p.source ?? "?"), lead: String(p.lead_benefit ?? "?") });
      }
    }
    byProduct.set(pid, e);
  }

  console.log(`angles scanned: ${(angles ?? []).length}   explore: ${explore}   exploit: ${exploit}`);
  console.log(`\n⇒ EXPLORE angles with NO competitor base: ${exploreNoComp} of ${explore}` +
    (explore ? `  (${((exploreNoComp / explore) * 100).toFixed(0)}%)` : ""));

  console.log(`\nby product:`);
  for (const [pid, e] of [...byProduct.entries()].sort((x, y) => y[1].noComp - x[1].noComp)) {
    if (!e.total) continue;
    console.log(`   ${String(title.get(pid) ?? pid).slice(0, 28).padEnd(30)} ${String(e.noComp).padStart(3)}/${String(e.total).padStart(3)} no-competitor   ${e.first} → ${e.last}`);
  }

  console.log(`\nexamples:`);
  for (const x of examples) console.log(`   ${x.id} ${x.when} ${x.product.slice(0, 24).padEnd(26)} source=${x.source.padEnd(16)} lead=${x.lead.slice(0, 44)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
