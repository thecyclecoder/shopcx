/**
 * Probe: everything needed before drafting an SMS blast.
 *  - recent campaigns (style, coupon/shortlink pattern, results)
 *  - segment counts across the subscribable book
 *  - segments_refreshed_at freshness (the SUMMERFIT stale-book rail)
 *  - whether the autonomous agent (Margo) is active, so we don't double-send
 * Read-only.
 */
import { createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  // ── recent campaigns ──────────────────────────────────────────────────────
  const { data: camps } = await admin
    .from("sms_campaigns")
    .select(
      "id, name, status, message_body, send_date, target_local_hour, included_segments, excluded_segments, coupon_enabled, coupon_code, shortlink_target_url, recipients_total, recipients_sent, recipients_delivered, created_at",
    )
    .eq("workspace_id", WS)
    .order("created_at", { ascending: false })
    .limit(24);

  console.log(`=== RECENT CAMPAIGNS (${camps?.length || 0}) ===`);
  for (const c of camps || []) {
    console.log(
      `\n[${c.status}] ${c.name}  send_date=${c.send_date} hour=${c.target_local_hour} created=${String(c.created_at).slice(0, 10)}`,
    );
    console.log(
      `  seg=${JSON.stringify(c.included_segments)} excl=${JSON.stringify(c.excluded_segments)} sent=${c.recipients_sent}/${c.recipients_total} delivered=${c.recipients_delivered}`,
    );
    console.log(`  coupon_enabled=${c.coupon_enabled} coupon_code=${c.coupon_code} target=${c.shortlink_target_url}`);
    console.log(`  body(${(c.message_body || "").length}): ${JSON.stringify(c.message_body)}`);
  }

  // ── segment counts over the subscribable book ─────────────────────────────
  const SEGMENTS = [
    "cycle_hitter",
    "lapsed",
    "engaged",
    "just_ordered",
    "deep_lapsed",
    "single_order",
    "active_sub",
    "storefront_signup",
    "cold",
  ];
  console.log(`\n=== SUBSCRIBABLE BOOK BY SEGMENT ===`);
  const { count: subscribable } = await admin
    .from("customers")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", WS)
    .eq("sms_marketing_status", "subscribed")
    .not("phone", "is", null);
  console.log(`sms_marketing_status='subscribed' with phone: ${subscribable}`);

  for (const seg of SEGMENTS) {
    const { count } = await admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", WS)
      .eq("sms_marketing_status", "subscribed")
      .not("phone", "is", null)
      .contains("segments", [seg]);
    // how many of those are ALSO active_sub (the default exclude)
    let net = count;
    if (seg !== "active_sub") {
      const { count: overlap } = await admin
        .from("customers")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", WS)
        .eq("sms_marketing_status", "subscribed")
        .not("phone", "is", null)
        .contains("segments", [seg, "active_sub"]);
      net = (count || 0) - (overlap || 0);
    }
    console.log(`  ${seg.padEnd(18)} ${String(count).padStart(7)}   net of active_sub: ${String(net).padStart(7)}`);
  }

  // ── freshness ─────────────────────────────────────────────────────────────
  console.log(`\n=== SEGMENT FRESHNESS (segments_refreshed_at) ===`);
  const now = Date.now();
  for (const [label, hours] of [
    ["<26h", 26],
    ["<48h", 48],
    ["<7d", 168],
  ] as [string, number][]) {
    const since = new Date(now - hours * 3600_000).toISOString();
    const { count } = await admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", WS)
      .eq("sms_marketing_status", "subscribed")
      .not("phone", "is", null)
      .gte("segments_refreshed_at", since);
    const pct = subscribable ? (((count || 0) / subscribable) * 100).toFixed(1) : "?";
    console.log(`  refreshed ${label.padEnd(5)} ${String(count).padStart(7)}  (${pct}%)`);
  }
  const { count: nullFresh } = await admin
    .from("customers")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", WS)
    .eq("sms_marketing_status", "subscribed")
    .not("phone", "is", null)
    .is("segments_refreshed_at", null);
  console.log(`  NULL segments_refreshed_at: ${nullFresh}`);

  // ── autonomous agent (Margo) ──────────────────────────────────────────────
  console.log(`\n=== SMS MARKETING POLICY (Margo) ===`);
  const { data: pol, error: polErr } = await admin
    .from("sms_marketing_policy")
    .select("*")
    .eq("workspace_id", WS)
    .maybeSingle();
  if (polErr) console.log(`  (error: ${polErr.message})`);
  else if (!pol) console.log("  no policy row");
  else
    console.log(
      `  active=${pol.active} weekly_cap=${pol.weekly_send_cap} min_gap=${pol.min_days_between_sends}\n  windows=${JSON.stringify(pol.send_windows)}\n  theme_config=${JSON.stringify(pol.theme_config)}`,
    );

  // ── anyone texted in the last 12h is auto-dropped; show recent send activity
  console.log(`\n=== RECENT SEND ACTIVITY (last 5 days) ===`);
  const { data: recent } = await admin
    .from("sms_campaigns")
    .select("name, status, last_send_at, recipients_sent")
    .eq("workspace_id", WS)
    .gte("last_send_at", new Date(now - 5 * 86400_000).toISOString())
    .order("last_send_at", { ascending: false });
  if (!recent?.length) console.log("  none in the last 5 days");
  for (const r of recent || []) console.log(`  ${r.last_send_at} ${r.name} (${r.status}) sent=${r.recipients_sent}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
