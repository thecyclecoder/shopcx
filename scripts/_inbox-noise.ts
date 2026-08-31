/**
 * The inbox has 2,237 undismissed notifications and 13 of them are decisions. Where does the rest
 * come from, is any of it meant to be read, and does anything ever clear it?
 *
 * This is the actual reason a card gets ignored — not that cards lie, but that the true ones are
 * buried 170:1.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const DAY = 86400_000;

async function main() {
  const a = createAdminClient();
  const all: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await a.from("dashboard_notifications")
      .select("id,title,type,created_at,dismissed,metadata")
      .eq("workspace_id", WS).order("created_at", { ascending: false }).range(off, off + 999);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const open = all.filter((n) => !n.dismissed);
  console.log(`notifications: ${all.length} total · ${open.length} undismissed (${(100 * open.length / all.length).toFixed(0)}%)`);

  console.log(`\n=== per type: volume, dismissal rate, age ===`);
  console.log("  type                      total   open  dismissed%   oldest open   newest");
  const types = [...new Set(all.map((n) => String(n.type)))];
  const rows = types.map((t) => {
    const mine = all.filter((n) => String(n.type) === t);
    const o = mine.filter((n) => !n.dismissed);
    const oldest = o.length ? String(o[o.length - 1].created_at).slice(0, 10) : "—";
    const newest = o.length ? String(o[0].created_at).slice(0, 10) : "—";
    return { t, total: mine.length, open: o.length, rate: 100 * (mine.length - o.length) / mine.length, oldest, newest };
  }).sort((x, y) => y.open - x.open);
  for (const r of rows) {
    console.log(`  ${r.t.padEnd(24)} ${String(r.total).padStart(6)} ${String(r.open).padStart(6)}   ${r.rate.toFixed(0).padStart(6)}%   ${r.oldest}    ${r.newest}`);
  }

  console.log(`\n=== how fast is the open pile growing? (undismissed, by day) ===`);
  const byDay: Record<string, number> = {};
  for (const n of open) byDay[String(n.created_at).slice(0, 10)] = (byDay[String(n.created_at).slice(0, 10)] ?? 0) + 1;
  const days = Object.keys(byDay).sort().slice(-10);
  for (const d of days) console.log(`  ${d}  ${String(byDay[d]).padStart(4)}  ${"█".repeat(Math.min(70, Math.round(byDay[d] / 4)))}`);
  const perDay = days.length ? days.reduce((x, d) => x + byDay[d], 0) / days.length : 0;
  console.log(`  ≈ ${perDay.toFixed(0)} new undismissed/day`);

  console.log(`\n=== the DECISION surface, in context ===`);
  const decisions = open.filter((n) => String(n.type) === "agent_approval_request");
  console.log(`  ${decisions.length} decisions buried in ${open.length} open items → 1 : ${Math.round(open.length / Math.max(1, decisions.length))}`);
  console.log(`  a decision arrives roughly every ${(open.length / Math.max(1, decisions.length) / Math.max(1, perDay) * 24).toFixed(0)}h of inbox volume`);

  // Do the noisy types carry an action, or are they log lines wearing a notification costume?
  console.log(`\n=== do the noisy types carry an actionable payload? ===`);
  for (const t of rows.filter((r) => r.open > 50).map((r) => r.t)) {
    const sample = open.filter((n) => String(n.type) === t).slice(0, 2);
    for (const s of sample) {
      const md = (s.metadata ?? {}) as Record<string, unknown>;
      const actionable = ["approve_action_id", "deep_link", "job_id"].filter((k) => md[k] != null);
      console.log(`  ${t.padEnd(22)} "${String(s.title).slice(0, 58)}"`);
      console.log(`      actionable fields: ${actionable.length ? actionable.join(", ") : "NONE — informational only"}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
