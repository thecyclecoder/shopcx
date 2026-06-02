/**
 * Local Klaviyo engagement backfill — resumable, with progress.
 *
 * Replaces the Inngest version (kept hitting Vercel timeouts).
 *
 * RESUMABLE: per-metric watermark comes from MAX(datetime) already in
 * profile_events. If the script crashes, restart it — each
 * metric automatically picks up where it left off. No external state
 * file. Worst case we re-fetch 1 second of overlap (gets deduped on
 * upsert via the unique (workspace_id, klaviyo_event_id) constraint).
 *
 * STATUS: per-page log showing fetch time + new rows + cumulative +
 * elapsed + a rough ETA. Per-metric summary line at the end.
 *
 * Pulls 180 days of: Clicked SMS, Opened Email, Clicked Email,
 * Viewed Product, Added to Cart, Checkout Started, Active on Site.
 *
 * Usage:
 *   npx tsx scripts/backfill-engagement-local.ts
 *   npx tsx scripts/backfill-engagement-local.ts --metric "Clicked SMS"
 *   npx tsx scripts/backfill-engagement-local.ts --days 90
 *   npx tsx scripts/backfill-engagement-local.ts --no-resume   # restart from window start
 */

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

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KLAVIYO_REVISION = "2025-01-15";
const PAGE_SIZE = 200;
const UPSERT_CHUNK = 100;
const PAGE_SLEEP_MS = 100;
const PROGRESS_EVERY = 5; // log every N pages

const METRICS = [
  "Clicked SMS",
  "Opened Email",
  "Clicked Email",
  "Viewed Product",
  "Added to Cart",
  "Checkout Started",
  "Active on Site",
] as const;

// Manual metric-ID override for this workspace. Some Klaviyo metrics
// don't surface via /api/metrics or the single-profile fallback probe
// (depends on Klaviyo's pagination ordering + whether the seed profile
// has events of that metric). When auto-resolution misses one, hardcode
// its id here. Auto-resolved ids still win if both are present, so
// adding entries is safe.
const MANUAL_METRIC_IDS: Record<string, string> = {
  "Clicked SMS": "XguEVT",
  "Opened Email": "P6RT4W",
  "Active on Site": "L4pUjd",
  "Clicked Email": "NtQQsj",
  "Viewed Product": "SjW2Lq",
  "Added to Cart": "XqHE4N",
  "Checkout Started": "XWgWge",
};

interface Args {
  days: number;
  metricFilter: string | null;
  metricIdFilter: string | null;
  noResume: boolean;
}
function parseArgs(): Args {
  const out: Args = { days: 180, metricFilter: null, metricIdFilter: null, noResume: false };
  const a = process.argv.slice(2);
  // Concatenate trailing tokens for --metric so multi-word names like
  // "Clicked Email" work even when shell wrappers strip quotes.
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--days") out.days = Number(a[++i]) || 180;
    else if (a[i] === "--metric") {
      const parts: string[] = [];
      while (i + 1 < a.length && !a[i + 1].startsWith("--")) parts.push(a[++i]);
      out.metricFilter = parts.join(" ");
    }
    else if (a[i] === "--metric-id") out.metricIdFilter = a[++i];
    else if (a[i] === "--no-resume") out.noResume = true;
  }
  return out;
}

// Ctrl-C handling: surface a clean line and exit. Watermark is
// always in the DB so the next run resumes naturally.
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.log("\n\nReceived SIGINT — finishing current page then exiting. Re-run the script to resume.");
});

async function resolveMetricIds(
  apiKey: string,
  supabase: ReturnType<typeof createClient>,
): Promise<Record<string, string>> {
  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    Accept: "application/json",
  };
  const ids: Record<string, string> = {};

  let url: string | null = "https://a.klaviyo.com/api/metrics?page[size]=200";
  while (url) {
    const r = await fetch(url, { headers });
    if (!r.ok) break;
    const b = (await r.json()) as {
      data: Array<{ id: string; attributes?: { name?: string } }>;
      links?: { next?: string };
    };
    for (const m of b.data || []) {
      const name = m.attributes?.name;
      if (name && (METRICS as readonly string[]).includes(name)) ids[name] = m.id;
    }
    url = b.links?.next || null;
  }

  // Fallback via event probe
  if (Object.keys(ids).length < METRICS.length) {
    const { data: anyEv } = await supabase
      .from("profile_events")
      .select("klaviyo_profile_id")
      .eq("workspace_id", WS)
      .limit(1)
      .maybeSingle();
    let seedProfile: string | undefined = anyEv?.klaviyo_profile_id;
    if (!seedProfile) {
      const { data: a2 } = await supabase
        .from("klaviyo_events")
        .select("klaviyo_profile_id")
        .eq("workspace_id", WS)
        .not("klaviyo_profile_id", "is", null)
        .limit(1)
        .maybeSingle();
      seedProfile = a2?.klaviyo_profile_id;
    }
    if (seedProfile) {
      const r = await fetch(
        "https://a.klaviyo.com/api/events" +
          `?filter=${encodeURIComponent(`equals(profile_id,"${seedProfile}")`)}` +
          `&page[size]=200&include=metric`,
        { headers },
      );
      const b = (await r.json()) as {
        included?: Array<{ type: string; id: string; attributes?: { name?: string } }>;
      };
      for (const inc of b.included || []) {
        if (inc.type !== "metric") continue;
        const name = inc.attributes?.name;
        if (name && (METRICS as readonly string[]).includes(name) && !ids[name]) ids[name] = inc.id;
      }
    }
  }
  // Final fallback: hardcoded MANUAL_METRIC_IDS for anything still
  // missing. Klaviyo's /api/metrics + single-profile probe can miss
  // metrics that exist but aren't on the seed profile's timeline.
  for (const [name, id] of Object.entries(MANUAL_METRIC_IDS)) {
    if (!ids[name]) ids[name] = id;
  }
  return ids;
}

async function getResumePoint(
  supabase: ReturnType<typeof createClient>,
  metricName: string,
): Promise<{ latestDatetime: string | null; existingCount: number }> {
  const { data: latest } = await supabase
    .from("profile_events")
    .select("datetime")
    .eq("workspace_id", WS)
    .eq("metric_name", metricName)
    .order("datetime", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { count } = await supabase
    .from("profile_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", WS)
    .eq("metric_name", metricName);
  return {
    latestDatetime: latest?.datetime || null,
    existingCount: count || 0,
  };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

async function pullMetric(
  metricName: string,
  metricId: string,
  apiKey: string,
  windowSinceIso: string,
  supabase: ReturnType<typeof createClient>,
  args: Args,
): Promise<{ added: number; pages: number; final: boolean }> {
  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    Accept: "application/json",
  };

  // Resume point: highest datetime already stored for this metric.
  const { latestDatetime, existingCount } = args.noResume
    ? { latestDatetime: null, existingCount: 0 }
    : await getResumePoint(supabase, metricName);

  // Klaviyo's `greater-than` filter is exclusive on datetime. To
  // avoid missing same-second events, back off by 1s — duplicates
  // dedupe on upsert.
  const sinceIso = latestDatetime
    ? new Date(new Date(latestDatetime).getTime() - 1000).toISOString()
    : windowSinceIso;

  console.log(
    `  Resume: ${
      latestDatetime
        ? `${existingCount} rows already, latest event_dt=${latestDatetime.slice(0, 19)} — fetching from ${sinceIso.slice(0, 19)} onward`
        : `no prior data — fetching full window from ${sinceIso.slice(0, 19)}`
    }`,
  );

  const filter = `and(equals(metric_id,"${metricId}"),greater-than(datetime,${sinceIso}))`;
  let url: string | null =
    "https://a.klaviyo.com/api/events" +
    `?filter=${encodeURIComponent(filter)}&sort=datetime&page[size]=${PAGE_SIZE}`;

  let added = 0;
  let page = 0;
  let lastDtSeen: string | null = null;
  const t0 = Date.now();

  while (url && !interrupted) {
    page++;
    const tFetch = Date.now();
    const r = await fetch(url, { headers });
    if (r.status === 429) {
      console.log(`    page ${page}: 429 rate-limited, sleeping 5s`);
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`${metricName} page ${page} ${r.status}: ${text.slice(0, 200)}`);
    }
    const body = (await r.json()) as {
      data: Array<{
        id: string;
        attributes?: {
          datetime?: string;
          timestamp?: number;
          event_properties?: Record<string, unknown>;
        };
        relationships?: { profile?: { data?: { id: string } | null } };
      }>;
      links?: { next?: string };
    };
    const fetchMs = Date.now() - tFetch;

    const rows = (body.data || [])
      .map((e) => {
        const profileId = e.relationships?.profile?.data?.id;
        if (!profileId) return null;
        const datetime =
          e.attributes?.datetime ||
          (e.attributes?.timestamp ? new Date(e.attributes.timestamp * 1000).toISOString() : null);
        if (!datetime) return null;
        const props = e.attributes?.event_properties || {};
        const rawValue = (props["$value"] ?? props["value"] ?? null) as unknown;
        const valueCents =
          typeof rawValue === "number" && Number.isFinite(rawValue)
            ? Math.round(rawValue * 100)
            : typeof rawValue === "string" && Number.isFinite(Number(rawValue))
              ? Math.round(Number(rawValue) * 100)
              : null;
        return {
          workspace_id: WS,
          klaviyo_profile_id: profileId,
          klaviyo_event_id: e.id,
          metric_name: metricName,
          datetime,
          value_cents: valueCents,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    let upsertMs = 0;
    if (rows.length > 0) {
      const tUp = Date.now();
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const batch = rows.slice(i, i + UPSERT_CHUNK);
        const { error } = await supabase
          .from("profile_events")
          .upsert(batch, {
            onConflict: "workspace_id,klaviyo_event_id",
            ignoreDuplicates: false,
          });
        if (error) throw new Error(`Upsert page ${page}: ${error.message}`);
      }
      upsertMs = Date.now() - tUp;
      lastDtSeen = rows[rows.length - 1].datetime;
    }

    added += rows.length;
    const elapsedMs = Date.now() - t0;
    const rate = added / Math.max(elapsedMs / 1000, 1);

    if (page === 1 || page % PROGRESS_EVERY === 0 || rows.length < PAGE_SIZE) {
      const last = lastDtSeen ? lastDtSeen.slice(0, 19) : "—";
      console.log(
        `    page ${page.toString().padStart(4)} | fetch ${fetchMs}ms upsert ${upsertMs}ms | +${rows.length} | cumulative ${added} | last_event_dt=${last} | ${rate.toFixed(1)}/s | elapsed ${fmtDuration(elapsedMs)}`,
      );
    }

    url = body.links?.next || null;
    if (url) await new Promise((res) => setTimeout(res, PAGE_SLEEP_MS));
  }

  const final = !interrupted && !url;
  const totalMs = Date.now() - t0;
  console.log(
    `  ${final ? "✓" : "⏸"} ${metricName}: ${final ? "complete" : "paused (will resume next run)"} — ${added} new in ${page} pages, ${fmtDuration(totalMs)}`,
  );
  return { added, pages: page, final };
}

async function main() {
  const args = parseArgs();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: ws } = await supabase
    .from("workspaces")
    .select("klaviyo_api_key_encrypted")
    .eq("id", WS)
    .single();
  if (!ws?.klaviyo_api_key_encrypted) throw new Error("Klaviyo API key not configured");
  const { decrypt } = await import("../src/lib/crypto");
  const apiKey = decrypt(ws.klaviyo_api_key_encrypted);

  await supabase
    .from("workspaces")
    .update({
      klaviyo_engagement_backfill_started_at: new Date().toISOString(),
      klaviyo_engagement_backfill_completed_at: null,
    })
    .eq("id", WS);

  console.log(`\nResolving metric IDs from Klaviyo...`);
  const metricIds = await resolveMetricIds(apiKey, supabase);
  for (const m of METRICS) {
    console.log(`  ${m.padEnd(20)} ${metricIds[m] || "(not resolved — will skip)"}`);
  }

  const targetMetrics = args.metricIdFilter
    ? METRICS.filter((m) => metricIds[m] === args.metricIdFilter)
    : args.metricFilter
      ? METRICS.filter((m) => m === args.metricFilter)
      : METRICS;
  const windowSinceIso = new Date(Date.now() - args.days * 86_400_000).toISOString();
  console.log(`\nWindow: last ${args.days} days (since ${windowSinceIso})\n`);

  const totals: Record<string, { added: number; pages: number; final: boolean }> = {};

  for (const metricName of targetMetrics) {
    if (interrupted) break;
    const metricId = metricIds[metricName];
    if (!metricId) {
      console.log(`\n[skip] ${metricName} — metric id not resolved`);
      continue;
    }
    console.log(`\n=== ${metricName} (${metricId}) ===`);
    totals[metricName] = await pullMetric(metricName, metricId, apiKey, windowSinceIso, supabase, args);
  }

  const allFinal = Object.values(totals).every((t) => t.final);

  if (allFinal && !interrupted) {
    console.log(`\nRebuilding summary rollups via SQL...`);
    const t0 = Date.now();
    const { error } = await supabase.rpc("rebuild_engagement_summary", { p_workspace_id: WS });
    if (error) throw new Error(`Summary rebuild failed: ${error.message}`);
    console.log(`✓ Summary rebuilt in ${fmtDuration(Date.now() - t0)}`);

    await supabase
      .from("workspaces")
      .update({ klaviyo_engagement_backfill_completed_at: new Date().toISOString() })
      .eq("id", WS);
    console.log(`\n✓ ALL DONE`);
  } else {
    console.log(`\n⏸ Backfill paused. Re-run the script to resume — per-metric watermarks are in the DB.`);
  }

  console.log(`\nResults:`);
  for (const [k, v] of Object.entries(totals)) {
    console.log(`  ${k.padEnd(20)} +${v.added} (${v.pages} pages) ${v.final ? "✓" : "⏸"}`);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
