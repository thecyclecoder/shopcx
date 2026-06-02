/**
 *   1. Backfill tracking_number / label_url / carrier on the 3 returns
 *      with null tracking (Heidi, Patricia, Penny) — from EasyPost.
 *   2. Spot-check the oldest 5 label_created returns by querying
 *      EasyPost directly to see whether they actually have any
 *      tracker events that our webhook should have processed.
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

const APPLY = process.argv.includes("--apply");
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN\n");

  const { data: ws } = await admin
    .from("workspaces")
    .select("easypost_live_api_key_encrypted")
    .eq("id", W)
    .single();
  const { decrypt } = await import("../src/lib/crypto");
  const easypostKey = decrypt(ws!.easypost_live_api_key_encrypted);
  const auth = "Basic " + Buffer.from(easypostKey + ":").toString("base64");

  // Pull all EasyPost-labelled returns
  const { data: returns } = await admin
    .from("returns")
    .select("id, order_number, status, tracking_number, carrier, label_url, easypost_shipment_id, shipped_at, delivered_at, created_at, customer_id")
    .eq("workspace_id", W)
    .not("easypost_shipment_id", "is", null)
    .order("created_at", { ascending: true });

  console.log(`Spot-checking ${returns?.length || 0} returns against EasyPost...\n`);

  for (const r of returns || []) {
    const ageDays = ((Date.now() - new Date(r.created_at).getTime()) / 86400000).toFixed(1);
    console.log(`────────────────────────────────────────`);
    console.log(`${r.order_number}  status=${r.status}  age=${ageDays}d`);
    console.log(`  shipment ${r.easypost_shipment_id}`);
    console.log(`  cached: tracking=${r.tracking_number || "NULL"}  carrier=${r.carrier || "NULL"}`);

    // Pull live shipment from EasyPost
    const shipRes = await fetch(`https://api.easypost.com/v2/shipments/${r.easypost_shipment_id}`, {
      headers: { Authorization: auth },
    });
    if (!shipRes.ok) { console.log(`  ⚠ EasyPost ${shipRes.status}`); continue; }
    const ship = await shipRes.json();
    const trackingNumber = ship.tracking_code as string | undefined;
    const labelUrl = ship.postage_label?.label_url as string | undefined;
    const carrier = ship.selected_rate?.carrier as string | undefined;
    const trackerId = ship.tracker?.id as string | undefined;

    console.log(`  EasyPost: tracking=${trackingNumber}  carrier=${carrier}`);

    // 1. Backfill if our cached values are missing
    const needsBackfill = !r.tracking_number && trackingNumber;
    if (needsBackfill) {
      console.log(`  ▶ Backfilling tracking/label/carrier on this row`);
      if (APPLY) {
        await admin.from("returns").update({
          tracking_number: trackingNumber,
          label_url: labelUrl,
          carrier,
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        console.log(`  ✓ backfilled`);
      }
    }

    // 2. Pull live tracker for delivery status
    if (trackerId) {
      const trkRes = await fetch(`https://api.easypost.com/v2/trackers/${trackerId}`, {
        headers: { Authorization: auth },
      });
      if (trkRes.ok) {
        const trk = await trkRes.json();
        const status = trk.status;
        const events = (trk.tracking_details || []) as { status: string; message: string; datetime: string; tracking_location?: { city?: string; state?: string } }[];
        console.log(`  Tracker: ${status}  events=${events.length}`);
        if (events.length > 0) {
          const last = events[events.length - 1];
          console.log(`    last: ${last.datetime}  ${last.status}  ${last.message}${last.tracking_location?.city ? ` (${last.tracking_location.city}, ${last.tracking_location.state})` : ""}`);
        }

        // Reconcile: update our row to match EasyPost reality if the
        // webhook silently missed events.
        const updates: Record<string, string | null> = {};
        if (status === "delivered" && !r.delivered_at) {
          console.log(`  ⚠⚠⚠ EasyPost says DELIVERED but our row has no delivered_at — fixing`);
          updates.status = "delivered";
          updates.delivered_at = events.find(e => e.status === "delivered")?.datetime || new Date().toISOString();
          if (!r.shipped_at) {
            const firstTransit = events.find(e => e.status === "in_transit" || e.status === "out_for_delivery");
            if (firstTransit) updates.shipped_at = firstTransit.datetime;
          }
        } else if ((status === "in_transit" || status === "out_for_delivery") && !r.shipped_at) {
          console.log(`  ⚠ EasyPost says ${status} but our row has no shipped_at — fixing`);
          updates.status = "in_transit";
          const firstTransit = events.find(e => e.status === "in_transit" || e.status === "out_for_delivery");
          updates.shipped_at = firstTransit?.datetime || new Date().toISOString();
        }
        if (Object.keys(updates).length > 0) {
          updates.updated_at = new Date().toISOString();
          if (APPLY) {
            await admin.from("returns").update(updates).eq("id", r.id);
            console.log(`  ✓ status reconciled to ${updates.status}`);

            // If we just flipped to delivered, fire the process-delivery
            // event so the refund flow runs (the webhook would have fired
            // this normally).
            if (updates.status === "delivered") {
              const inngestKey = process.env.INNGEST_EVENT_KEY;
              if (inngestKey) {
                await fetch("https://inn.gs/e/" + inngestKey, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: "returns/process-delivery",
                    data: { return_id: r.id, workspace_id: W },
                  }),
                });
                console.log(`  ✓ fired returns/process-delivery for ${r.id}`);
              }
            }
          }
        }
      }
    } else {
      console.log(`  (no tracker on shipment yet — label may not have been scanned)`);
    }
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
