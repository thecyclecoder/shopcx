/**
 * Pull `Received SMS` events from Klaviyo.
 *
 * Same shape as backfill-engagement-local.ts but focused on a single
 * metric. We deliberately excluded Received SMS from the main engagement
 * backfill (it was tier-0 "things we did, not signals from them") — but
 * for case-control analysis of segments, we need it: it's the only way
 * to reconstruct per-campaign recipient lists.
 *
 * Resumable via MAX(datetime) watermark on klaviyo_profile_events.
 * Idempotent upserts on (workspace_id, klaviyo_event_id).
 *
 * Usage:
 *   npx tsx scripts/backfill-received-sms.ts            # 100d default
 *   npx tsx scripts/backfill-received-sms.ts --days 120
 *   npx tsx scripts/backfill-received-sms.ts --no-resume
 */

import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const METRIC_NAME = "Received SMS";
const METRIC_ID = "Vu4Mrq";
const KLAVIYO_REVISION = "2025-01-15";
const PAGE_SIZE = 200;
const UPSERT_CHUNK = 200;

function parseArgs() {
  const out = { days: 100, noResume: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--days") out.days = Number(a[++i]) || 100;
    else if (a[i] === "--no-resume") out.noResume = true;
  }
  return out;
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.log("\n\nReceived SIGINT — finishing current page then exiting. Re-run to resume.");
});

async function main() {
  const args = parseArgs();
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Get Klaviyo API key
  const { data: ws } = await supabase.from("workspaces").select("klaviyo_api_key_encrypted").eq("id", WS).single();
  const apiKey = decrypt(ws!.klaviyo_api_key_encrypted);
  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    Accept: "application/json",
  };

  // Watermark: latest Received SMS datetime in our DB
  let sinceIso: string;
  if (args.noResume) {
    sinceIso = new Date(Date.now() - args.days * 86_400_000).toISOString();
  } else {
    const { data: latest } = await supabase
      .from("klaviyo_profile_events")
      .select("datetime")
      .eq("workspace_id", WS)
      .eq("metric_name", METRIC_NAME)
      .order("datetime", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.datetime) {
      // 1s overlap to catch same-second events
      sinceIso = new Date(new Date(latest.datetime).getTime() - 1000).toISOString();
      console.log(`Resuming from existing watermark: ${sinceIso}`);
    } else {
      sinceIso = new Date(Date.now() - args.days * 86_400_000).toISOString();
      console.log(`No prior data — starting from ${args.days}d ago: ${sinceIso}`);
    }
  }

  const filter = `and(equals(metric_id,"${METRIC_ID}"),greater-than(datetime,${sinceIso}))`;
  let url: string | null =
    "https://a.klaviyo.com/api/events" +
    `?filter=${encodeURIComponent(filter)}&sort=datetime&page[size]=${PAGE_SIZE}`;

  let totalAdded = 0;
  let page = 0;
  const t0 = Date.now();

  while (url && !interrupted) {
    page++;
    const r = await fetch(url, { headers });
    if (r.status === 429) {
      console.log(`  page ${page}: 429 rate-limited, sleeping 5s`);
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`page ${page} ${r.status}: ${text.slice(0, 200)}`);
    }
    const body = (await r.json()) as {
      data: Array<{
        id: string;
        attributes?: { datetime?: string; timestamp?: number };
        relationships?: { profile?: { data?: { id: string } | null } };
      }>;
      links?: { next?: string };
    };

    const rows = (body.data || [])
      .map((e) => {
        const profileId = e.relationships?.profile?.data?.id;
        if (!profileId) return null;
        const datetime =
          e.attributes?.datetime ||
          (e.attributes?.timestamp ? new Date(e.attributes.timestamp * 1000).toISOString() : null);
        if (!datetime) return null;
        return {
          workspace_id: WS,
          klaviyo_profile_id: profileId,
          klaviyo_event_id: e.id,
          metric_name: METRIC_NAME,
          datetime,
          value_cents: null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const batch = rows.slice(i, i + UPSERT_CHUNK);
        const { error } = await supabase
          .from("klaviyo_profile_events")
          .upsert(batch, { onConflict: "workspace_id,klaviyo_event_id", ignoreDuplicates: false });
        if (error) throw new Error(`page ${page} upsert: ${error.message}`);
      }
      totalAdded += rows.length;
    }

    if (page % 25 === 0) {
      const elapsedMs = Date.now() - t0;
      const rate = (totalAdded / (elapsedMs / 1000)).toFixed(1);
      const lastDt = rows[rows.length - 1]?.datetime || "?";
      console.log(`  page ${page} | total +${totalAdded} | ${rate}/sec | latest event ${lastDt}`);
    }

    url = body.links?.next || null;
  }

  const elapsedMs = Date.now() - t0;
  console.log(`\n✓ DONE — pages=${page} added=${totalAdded} time=${(elapsedMs / 60_000).toFixed(1)}min rate=${(totalAdded / (elapsedMs / 1000)).toFixed(1)}/sec`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
