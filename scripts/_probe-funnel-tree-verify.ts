/**
 * Verify computeFunnelTree against the live DB and reconcile its grandTotal
 * against an independent raw count (the legacy funnel's method). Read-only.
 */
import { createAdminClient } from "./_bootstrap";
import { computeFunnelTree, listFunnelProducts, type FunnelNode } from "@/lib/storefront/funnel-tree";

function centralBoundary(yyyyMmDd: string, endOfDay: boolean): string {
  const time = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const noon = new Date(`${yyyyMmDd}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" });
  const tzName = fmt.formatToParts(noon).find((p) => p.type === "timeZoneName")?.value || "";
  const m = tzName.match(/GMT([+-])(\d\d):(\d\d)/);
  let off = 0;
  if (m) off = (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(new Date(`${yyyyMmDd}${time}`).getTime() - off * 60_000).toISOString();
}

function pct(n: number) { return (n * 100).toFixed(1) + "%"; }

function printTree(nodes: FunnelNode[], depth = 0) {
  for (const n of nodes) {
    const pad = "  ".repeat(depth);
    const m = n.metrics;
    console.log(
      `${pad}${n.label.slice(0, 46).padEnd(48 - pad.length)} ` +
      `visit=${String(m.visit).padStart(4)} eng=${String(m.engaged).padStart(4)} ` +
      `pack=${String(m.pack_selected).padStart(3)} co=${String(m.checkout_started).padStart(3)} ord=${String(m.order_placed).padStart(3)} ` +
      `| engR=${pct(m.engagement_rate).padStart(6)} cvr=${pct(m.conversion_rate).padStart(6)}`,
    );
    if (n.children) printTree(n.children, depth + 1);
  }
}

async function rawGrandTotal(admin: ReturnType<typeof createAdminClient>, ws: string, startIso: string, endIso: string) {
  // Independent method matching the SDK's definition: visit = distinct real
  // sessions firing ANY event in window; deeper steps = distinct sessions per
  // step event. Excludes internal/bot/internal-customer.
  const { data: ic } = await admin.from("customers").select("id").eq("workspace_id", ws).eq("is_internal", true);
  const icIds = new Set((ic || []).map((c) => c.id as string));
  const stepTypes = ["pdp_engaged", "pack_selected", "checkout_view", "order_placed"];
  const anyEvent = new Set<string>();
  const out: Record<string, Set<string>> = {};
  for (const t of stepTypes) out[t] = new Set();
  let from = 0;
  for (;;) {
    const { data } = await admin.from("storefront_events").select("event_type, session_id")
      .eq("workspace_id", ws).gte("created_at", startIso).lte("created_at", endIso)
      .order("id", { ascending: true }).range(from, from + 999);
    const rows = data || [];
    for (const r of rows) { anyEvent.add(r.session_id as string); out[r.event_type as string]?.add(r.session_id as string); }
    if (rows.length < 1000) break; from += 1000;
  }
  const internalSess = new Set<string>();
  const idArr = [...anyEvent];
  for (let i = 0; i < idArr.length; i += 300) {
    const { data } = await admin.from("storefront_sessions").select("id, is_internal, is_bot, customer_id").in("id", idArr.slice(i, i + 300));
    for (const s of data || []) if (s.is_internal || s.is_bot || (s.customer_id && icIds.has(s.customer_id as string))) internalSess.add(s.id as string);
  }
  const count = (set: Set<string>) => [...set].filter((id) => !internalSess.has(id)).length;
  return { visit: count(anyEvent), engaged: count(out["pdp_engaged"]), pack: count(out["pack_selected"]), checkout: count(out["checkout_view"]), order: count(out["order_placed"]) };
}

async function main() {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id").eq("name", "Superfoods Company").maybeSingle();
  const wsId = ws!.id as string;

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const d30 = new Date(Date.now() - 30 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  for (const [label, start, end] of [["TODAY", today, today], ["LAST 30 DAYS", d30, today]] as const) {
    const startIso = centralBoundary(start, false), endIso = centralBoundary(end, true);
    const tree = await computeFunnelTree({ admin, workspaceId: wsId, startIso, endIso });
    console.log(`\n========== ${label} (${start} → ${end}) ==========`);
    printTree(tree.products);
    if (tree.unattributedEntry) printTree([tree.unattributedEntry]);
    const g = tree.grandTotal;
    console.log(`GRAND TOTAL (SDK): visit=${g.visit} eng=${g.engaged} pack=${g.pack_selected} co=${g.checkout_started} ord=${g.order_placed}`);
    const raw = await rawGrandTotal(admin, wsId, startIso, endIso);
    console.log(`RAW   (independent): visit=${raw.visit} eng=${raw.engaged} pack=${raw.pack} co=${raw.checkout} ord=${raw.order}`);
    const ok = g.visit === raw.visit && g.engaged === raw.engaged && g.pack_selected === raw.pack && g.checkout_started === raw.checkout && g.order_placed === raw.order;
    console.log(ok ? "✅ RECONCILES" : "❌ MISMATCH");
  }

  const start30Iso = centralBoundary(d30, false), endIso = centralBoundary(today, true);
  console.log("\n=== DROPDOWN (listFunnelProducts, 30d) ===");
  console.table(await listFunnelProducts({ admin, workspaceId: wsId, startIso: start30Iso, endIso }));
}

main().catch((e) => { console.error(e); process.exit(1); });
