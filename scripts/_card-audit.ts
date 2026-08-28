/**
 * Are the CEO's escalation cards TRUE?
 *
 * Two cards today asserted things that were not so: the cold-scaler stall cards counted revoked
 * crowns as pending work, and a claim-gate asserted "author lane silently failed upstream" for a
 * spec that exists and shipped. Both cost real investigation time. If cards cannot be trusted, the
 * rational response is to stop reading them — which is worse than having none.
 *
 * This surveys every undismissed card and looks for the STRUCTURAL tells, rather than re-verifying
 * each claim by hand:
 *   · re-firing — the same condition raised again and again (a dedupe key that resets daily)
 *   · staleness — the referenced job/spec has since resolved
 *   · unverified causation — the body asserts WHY, and the why is a guess
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  // Page ALL of them — a 300-row limit ordered by recency buries the decision surface under
  // high-volume `system` noise, which is how the first pass reported 0 causal cards while one
  // was sitting in the inbox.
  const all: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("dashboard_notifications")
      .select("id,title,body,created_at,dismissed,type,metadata")
      .eq("workspace_id", WS).eq("dismissed", false)
      .order("created_at", { ascending: false }).range(off, off + 999);
    if (error) throw new Error(`dashboard_notifications: ${error.message}`);
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`undismissed notifications (ALL): ${all.length}`);
  const byType: Record<string, number> = {};
  for (const n of all) byType[String(n.type)] = (byType[String(n.type)] ?? 0) + 1;
  console.log("by type:");
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);

  // THE DECISION SURFACE — what /ceo-approvals actually renders.
  const notifs = all.filter((n) => String(n.type) === "agent_approval_request");
  console.log(`\n>>> decision surface (type=agent_approval_request): ${notifs.length}`);

  // ── by escalation kind ───────────────────────────────────────────────────
  const byKind: Record<string, Array<Record<string, unknown>>> = {};
  for (const n of notifs ?? []) {
    const k = String((n.metadata as Record<string, unknown> | null)?.escalation_kind ?? n.type ?? "—");
    (byKind[k] ??= []).push(n);
  }
  console.log("\n=== by escalation kind ===");
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
    const oldest = v[v.length - 1], newest = v[0];
    const spanDays = Math.round((Date.parse(String(newest.created_at)) - Date.parse(String(oldest.created_at))) / 86400000);
    console.log(`  ${k.padEnd(42)} ${String(v.length).padStart(3)} card(s)  spanning ${spanDays}d`);
  }

  // ── re-firing: same dedupe root, many cards ──────────────────────────────
  console.log("\n=== RE-FIRING (same condition, repeated cards) ===");
  const byRoot: Record<string, Array<Record<string, unknown>>> = {};
  for (const n of notifs ?? []) {
    const dk = String((n.metadata as Record<string, unknown> | null)?.dedupe_key ?? "");
    if (!dk) continue;
    // Strip a trailing yyyy-mm-dd so "same condition, different day" collapses.
    const root = dk.replace(/:\d{4}-\d{2}-\d{2}$/, "");
    (byRoot[root] ??= []).push(n);
  }
  const repeat = Object.entries(byRoot).filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
  if (!repeat.length) console.log("  none");
  for (const [root, v] of repeat.slice(0, 12)) {
    const days = v.map((x) => String(x.created_at).slice(0, 10)).sort();
    console.log(`  ${String(v.length).padStart(3)}x  ${root.slice(0, 90)}`);
    console.log(`        ${days[0]} → ${days[days.length - 1]}  ·  "${String(v[0].title).slice(0, 70)}"`);
  }

  // ── staleness: does the referenced job still need attention? ─────────────
  console.log("\n=== STALENESS — referenced jobs vs their current status ===");
  const jobIds = [...new Set((notifs ?? [])
    .map((n) => String((n.metadata as Record<string, unknown> | null)?.job_id ?? ""))
    .filter(Boolean))];
  if (jobIds.length) {
    const { data: jobs } = await admin.from("agent_jobs").select("id,kind,status,spec_slug").in("id", jobIds);
    const byId = new Map((jobs ?? []).map((j) => [String(j.id), j]));
    const TERMINAL = new Set(["completed", "merged", "dismissed", "folded", "shipped"]);
    let stale = 0;
    for (const n of notifs ?? []) {
      const jid = String((n.metadata as Record<string, unknown> | null)?.job_id ?? "");
      if (!jid) continue;
      const j = byId.get(jid);
      if (!j) { console.log(`  ⚠ card references a MISSING job ${jid.slice(0, 8)} — "${String(n.title).slice(0, 60)}"`); stale += 1; continue; }
      if (TERMINAL.has(String(j.status))) {
        console.log(`  ⚠ STALE: job ${jid.slice(0, 8)} is '${j.status}' — "${String(n.title).slice(0, 60)}"`);
        stale += 1;
      }
    }
    console.log(`  ${stale} card(s) point at an already-terminal or missing job.`);
  } else console.log("  no cards carry a job_id");

  // ── unverified causation: bodies that assert WHY ─────────────────────────
  console.log("\n=== CARDS THAT ASSERT A CAUSE ===");
  const CAUSAL = /silently failed|never landed|author lane|likely|probably|must have|appears to have/i;
  let causal = 0;
  for (const n of notifs ?? []) {
    const body = String(n.body ?? "");
    const m = body.match(CAUSAL);
    if (!m) continue;
    causal += 1;
    console.log(`  [${String(n.created_at).slice(0, 10)}] "${String(n.title).slice(0, 62)}"`);
    const i = body.search(CAUSAL);
    console.log(`      asserts: …${body.slice(Math.max(0, i - 60), i + 130).replace(/\n/g, " ")}…`);
  }
  console.log(`  ${causal} card(s) assert a cause in prose. Each is a claim someone will act on.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
