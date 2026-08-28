/**
 * Read the CEO approvals inbox through the SAME builder the page uses, and surface every
 * cold-scaler / media-buyer card so each claim can be checked against live state.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { buildApprovalsFeed } from "../src/lib/agents/approvals-feed";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RE = /cold.?scaler|scaler|graduat|arming|crown|media.?buyer|bianca/i;

async function main() {
  const admin = createAdminClient();
  const feed = await buildApprovalsFeed(admin, WS);
  const groups = Object.entries(feed as unknown as Record<string, unknown>);
  for (const [k, v] of groups) {
    if (!Array.isArray(v)) { console.log(`${k}: ${JSON.stringify(v)}`); continue; }
    console.log(`\n=== ${k} — ${v.length} item(s) ===`);
    for (const it of v as Array<Record<string, unknown>>) {
      const blob = JSON.stringify(it);
      if (!RE.test(blob)) continue;
      console.log(`\n  ── ${String(it.title ?? it.id ?? "").slice(0, 100)}`);
      for (const f of ["id", "created_at", "kind", "status", "spec_slug", "escalation_reason"]) {
        if (it[f] != null) console.log(`     ${f.padEnd(18)} ${String(it[f]).slice(0, 110)}`);
      }
      const body = String(it.body ?? "");
      if (body) console.log(`     body: ${body.slice(0, 900)}`);
      if (it.metadata) console.log(`     metadata: ${JSON.stringify(it.metadata).slice(0, 500)}`);
    }
  }

  // Raw notification rows too — the feed may filter or reshape.
  const { data: notifs } = await admin.from("dashboard_notifications")
    .select("id,title,body,created_at,dismissed,type,metadata").eq("workspace_id", WS)
    .eq("dismissed", false).order("created_at", { ascending: false }).limit(60);
  const hits = (notifs ?? []).filter((n) => RE.test(JSON.stringify(n)));
  console.log(`\n\n=== RAW undismissed dashboard_notifications matching scaler/crown/bianca: ${hits.length} ===`);
  for (const n of hits) {
    console.log(`\n  [${String(n.created_at).slice(0, 16)}] ${n.type} · ${String(n.title).slice(0, 110)}`);
    console.log(`     ${String(n.body ?? "").slice(0, 700)}`);
    if (n.metadata) console.log(`     metadata: ${JSON.stringify(n.metadata).slice(0, 400)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
