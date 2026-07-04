// apply-sms-marketing-agent-migration — create the SMS Marketing Agent (CMO/Iris) stack:
//   sms_marketing_policy      — per-workspace dormant on-switch + cadence guardrails + theme wiring
//   sms_campaign_templates    — DB-driven copy library (theme × segment)
//   sms_campaign_grades       — KPI (revenue-per-send) grading
//   sms_campaigns.source / .agent_theme — provenance columns
// Then seeds the Superfoods workspace DORMANT (active=false): the 5 candidate send windows,
// the default segment scope, placeholder theme coupon wiring, and the VIP/Weekend template
// library. Iris/Dylan flips active=true (and sets real Shopify codes) to go live.
//
// Statement-by-statement apply + one compact `>>> APPLY RESULT:` verdict line (the box worker
// keeps only the last ~500 chars). Idempotent throughout. Run against the pooler:
//   npx tsx scripts/apply-sms-marketing-agent-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260704120000_sms_marketing_agent.sql";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

function verdict(line: string) {
  console.log(`>>> APPLY RESULT: ${line}`);
  console.error(`>>> APPLY RESULT: ${line}`);
}
function statements(sql: string): string[] {
  const noComments = sql.split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
  return noComments.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}
function pgTail(e: any): string {
  const b: string[] = [];
  if (e?.code) b.push(`code=${e.code}`);
  if (e?.detail) b.push(`detail=${String(e.detail).slice(0, 120)}`);
  if (e?.message) b.push(String(e.message).slice(0, 160));
  return b.join(" · ") || String(e);
}

// ── the 5 candidate send windows Dylan named (0=Sun) ──
const SEND_WINDOWS = [
  { weekday: 0, hour: 9, theme: "weekend" },  // Sunday morning
  { weekday: 1, hour: 9, theme: "vip" },      // Monday morning
  { weekday: 2, hour: 18, theme: "vip" },     // Tuesday evening
  { weekday: 4, hour: 9, theme: "vip" },      // Thursday morning
  { weekday: 6, hour: 9, theme: "weekend" },  // Saturday morning
];
const THEME_CONFIG = {
  vip: { code: "VIPWEEKLY", collection: "vip-early-access", discount_label: "up to 60% off" },
  weekend: { code: "WEEKEND", collection: "weekend-sale", discount_label: "up to 50% off" },
};
const POLICY_RATIONALE =
  "SMS marketing agent under Iris (CMO). DORMANT (active=false). Sends VIP + Weekend sales on the 5 candidate " +
  "windows (Sun AM, Mon AM, Tue PM, Thu AM, Sat AM), 1-2/week. theme_config codes are PLACEHOLDERS — set real " +
  "Shopify codes + collections, then flip active=true to go live. KPI = attributed revenue-per-send.";

// ── template library (theme × segment): hook / cta / signoff. '*' = theme fallback ──
const VIP_CTA = "Tap to claim:";
const WKND_CTA = "Get your coupon:";
const VIP_SIGNOFF = "Shed lbs, feel great for summer! Only 39 left!";
const WKND_SIGNOFF = "Get summer-ready - this weekend only!";
const TEMPLATES: Array<{ theme: string; segment: string; hook: string; cta: string; signoff: string }> = [
  // VIP — "you're chosen / early access"
  { theme: "vip", segment: "*",            hook: "You're picked for VIP early access!",      cta: VIP_CTA, signoff: VIP_SIGNOFF },
  { theme: "vip", segment: "cycle_hitter", hook: "VIPs only - time to restock!",             cta: VIP_CTA, signoff: VIP_SIGNOFF },
  { theme: "vip", segment: "lapsed",       hook: "VIPs only - come back and save!",          cta: VIP_CTA, signoff: VIP_SIGNOFF },
  { theme: "vip", segment: "engaged",      hook: "You're picked for VIP early access!",      cta: VIP_CTA, signoff: VIP_SIGNOFF },
  { theme: "vip", segment: "deep_lapsed",  hook: "VIPs only - we miss you!",                 cta: VIP_CTA, signoff: VIP_SIGNOFF },
  { theme: "vip", segment: "single_order", hook: "VIP early access - ready for order #2?",   cta: VIP_CTA, signoff: VIP_SIGNOFF },
  { theme: "vip", segment: "active_sub",   hook: "Thanks for subscribing - VIP code inside!", cta: VIP_CTA, signoff: VIP_SIGNOFF },
  // Weekend — "this weekend only flash sale"
  { theme: "weekend", segment: "*",            hook: "Our weekend flash sale is live!",       cta: WKND_CTA, signoff: WKND_SIGNOFF },
  { theme: "weekend", segment: "cycle_hitter", hook: "Weekend sale - time to restock!",       cta: WKND_CTA, signoff: WKND_SIGNOFF },
  { theme: "weekend", segment: "lapsed",       hook: "Weekend sale - come back and save!",    cta: WKND_CTA, signoff: WKND_SIGNOFF },
  { theme: "weekend", segment: "engaged",      hook: "Weekend flash sale is live!",           cta: WKND_CTA, signoff: WKND_SIGNOFF },
  { theme: "weekend", segment: "deep_lapsed",  hook: "Weekend sale - we miss you!",           cta: WKND_CTA, signoff: WKND_SIGNOFF },
  { theme: "weekend", segment: "single_order", hook: "Weekend sale - ready for order #2?",    cta: WKND_CTA, signoff: WKND_SIGNOFF },
  { theme: "weekend", segment: "active_sub",   hook: "Weekend thanks for subscribing!",       cta: WKND_CTA, signoff: WKND_SIGNOFF },
];

async function main() {
  const c = pgClient();
  try { await c.connect(); } catch (e) { verdict(`connect failed — ${pgTail(e)}`); process.exit(1); }
  try {
    const stmts = statements(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    for (let i = 0; i < stmts.length; i++) {
      const head = stmts[i].replace(/\s+/g, " ").slice(0, 70);
      try { await c.query(stmts[i]); console.log(`  ✓ [${i + 1}/${stmts.length}] ${head}`); }
      catch (e) { verdict(`DDL statement ${i + 1}/${stmts.length} FAILED — "${head}…" — ${pgTail(e)}`); await c.end().catch(() => {}); process.exit(1); }
    }
    console.log(`✓ applied ${MIGRATION} (${stmts.length} statements)`);

    // verify the 3 tables + provenance column exist
    for (const t of ["sms_marketing_policy", "sms_campaign_templates", "sms_campaign_grades"]) {
      const { rows } = await c.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name=$1", [t]);
      if (rows[0].n === 0) { await c.end(); verdict(`table public.${t} MISSING after apply`); process.exit(1); }
      console.log(`  ✓ public.${t} (${rows[0].n} cols)`);
    }
    const { rows: srcCol } = await c.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='sms_campaigns' and column_name in ('source','agent_theme')");
    if (srcCol[0].n !== 2) { await c.end(); verdict(`sms_campaigns provenance columns MISSING (expected 2, got ${srcCol[0].n})`); process.exit(1); }

    // ── SEED (guarded, dormant) ──
    await c.query(
      `insert into public.sms_marketing_policy
         (workspace_id, active, weekly_send_cap, min_days_between_sends, send_windows, theme_config, created_by, rationale)
       values ($1, false, 2, 2, $2::jsonb, $3::jsonb, 'human', $4)
       on conflict (workspace_id) do nothing`,
      [WS, JSON.stringify(SEND_WINDOWS), JSON.stringify(THEME_CONFIG), POLICY_RATIONALE],
    );
    let tSeeded = 0;
    for (const t of TEMPLATES) {
      const r = await c.query(
        `insert into public.sms_campaign_templates (workspace_id, theme, segment, hook, cta, signoff)
         values ($1,$2,$3,$4,$5,$6) on conflict (workspace_id, theme, segment) do nothing`,
        [WS, t.theme, t.segment, t.hook, t.cta, t.signoff],
      );
      tSeeded += r.rowCount || 0;
    }
    const { rows: pol } = await c.query("select active, weekly_send_cap, jsonb_array_length(send_windows) w from public.sms_marketing_policy where workspace_id=$1", [WS]);
    const { rows: tpl } = await c.query("select count(*)::int n from public.sms_campaign_templates where workspace_id=$1", [WS]);
    await c.end();
    verdict(
      `OK — 3 tables live. Policy: active=${pol[0]?.active} (DORMANT), weekly_cap=${pol[0]?.weekly_send_cap}, windows=${pol[0]?.w}. ` +
        `Templates: ${tpl[0].n} total (${tSeeded} newly seeded). Set real Shopify codes in theme_config + flip active=true to go live.`,
    );
  } catch (e) { verdict(`unexpected — ${pgTail(e)}`); await c.end().catch(() => {}); process.exit(1); }
}
main().then(() => process.exit(0)).catch((e) => { verdict(`fatal — ${pgTail(e)}`); process.exit(1); });
