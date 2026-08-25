/**
 * Daily new-subs vs cancels — the Phase 1 "flat line" condition, day by day.
 * Cancels come from customer_events (brain: tables/customer_events — the sub row has no cancelled_at),
 * deduped for the known portal+appstle double-fire.
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FROM = "2026-07-25", TO = "2026-08-24";

const dayOf = (iso: string) => new Date(new Date(iso).getTime() - 5 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const admin = createAdminClient();
  const lo = `${FROM}T00:00:00-05:00`, hi = `${TO}T23:59:59.999-05:00`;

  const subs: Array<{ created_at: string }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("subscriptions").select("created_at")
      .eq("workspace_id", WS).gte("created_at", lo).lte("created_at", hi).range(off, off + 999);
    if (error) throw new Error(`subscriptions: ${error.message}`);
    subs.push(...((data ?? []) as typeof subs));
    if (!data || data.length < 1000) break;
  }

  const evts: Array<{ customer_id: string | null; created_at: string; event_type: string; source: string | null }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("customer_events").select("customer_id,created_at,event_type,source")
      .eq("workspace_id", WS)
      .in("event_type", ["subscription.cancelled", "portal.subscription.cancelled"])
      .gte("created_at", lo).lte("created_at", hi).range(off, off + 999);
    if (error) throw new Error(`customer_events: ${error.message}`);
    evts.push(...((data ?? []) as typeof evts));
    if (!data || data.length < 1000) break;
  }

  const seen = new Set<string>();
  const newBy: Record<string, number> = {}, canBy: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const s of subs) newBy[dayOf(s.created_at)] = (newBy[dayOf(s.created_at)] ?? 0) + 1;
  for (const e of evts) {
    const k = `${e.customer_id}|${e.created_at.slice(0, 16)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    canBy[dayOf(e.created_at)] = (canBy[dayOf(e.created_at)] ?? 0) + 1;
    bySource[`${e.event_type} / ${e.source ?? "—"}`] = (bySource[`${e.event_type} / ${e.source ?? "—"}`] ?? 0) + 1;
  }

  const days = [...new Set([...Object.keys(newBy), ...Object.keys(canBy)])].sort();
  console.log("date          new   cancels    net");
  let cum = 0;
  for (const d of days) {
    const n = newBy[d] ?? 0, c = canBy[d] ?? 0, net = n - c;
    cum += net;
    console.log(`${d}   ${String(n).padStart(3)}   ${String(c).padStart(7)}   ${(net >= 0 ? "+" : "") + net}`.padEnd(46) + `  cum ${cum >= 0 ? "+" : ""}${cum}  ${"█".repeat(Math.min(40, c))}`);
  }

  console.log("\ncancel rows by (event_type / source), deduped:");
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(46)} ${v}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
