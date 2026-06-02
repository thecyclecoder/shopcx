import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { count: campCount } = await admin.from("klaviyo_sms_campaign_history")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", W);
  console.log(`Campaigns imported: ${campCount}`);

  const { count: evCount } = await admin.from("klaviyo_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", W);
  console.log(`Events imported: ${evCount}`);

  const { data: latestEv } = await admin.from("klaviyo_events")
    .select("datetime, imported_at")
    .eq("workspace_id", W)
    .order("imported_at", { ascending: false })
    .limit(1);
  if (latestEv?.[0]) {
    console.log(`Latest event imported_at: ${latestEv[0].imported_at}`);
    console.log(`Latest event datetime:    ${latestEv[0].datetime}`);
  }

  const { count: withAttribution } = await admin.from("klaviyo_sms_campaign_history")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", W)
    .not("initial_revenue_computed_at", "is", null);
  console.log(`Campaigns with Initial Revenue computed: ${withAttribution}`);

  if ((campCount || 0) > 0) {
    const { data: top } = await admin.from("klaviyo_sms_campaign_history")
      .select("name, send_time, recipients, conversions, conversion_value_cents, initial_conversions, initial_conversion_value_cents")
      .eq("workspace_id", W)
      .order("send_time", { ascending: false })
      .limit(5);
    console.log(`\n5 most recent campaigns:`);
    for (const c of top || []) {
      const klavRev = c.conversion_value_cents != null ? `$${(c.conversion_value_cents/100).toFixed(0)}` : "—";
      const initRev = c.initial_conversion_value_cents != null ? `$${(c.initial_conversion_value_cents/100).toFixed(0)}` : "(pending)";
      console.log(`  ${c.send_time?.slice(0,10)} ${c.name}`);
      console.log(`    recipients=${c.recipients} klav_conv=${c.conversions} klav_rev=${klavRev} init_conv=${c.initial_conversions ?? "—"} init_rev=${initRev}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
