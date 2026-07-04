/**
 * Phase 1c — backfill profile_events.customer_id from
 * klaviyo_profile_staging.
 *
 * For each staging row where customer_id IS NOT NULL, UPDATE all
 * events with the same klaviyo_profile_id (and currently NULL
 * customer_id) to set customer_id to the resolved value.
 *
 * Batched at 1000 profile_ids per UPDATE statement to avoid lock
 * contention. Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-events-customer-id.ts
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

import { pgClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
// klaviyo_profile_ids per set-based UPDATE. Chunking the join keeps each
// statement's lock footprint on the 3.2M-row profile_events table bounded
// (instead of one giant table-wide UPDATE), while still doing the
// profile→customer mapping as a single SQL join per statement — not one
// UPDATE per (customer, 1000-profile) task as the old loop did.
const PROFILE_BATCH = 2000;

async function main() {
  const pg = pgClient();
  await pg.connect();
  const t0 = Date.now();
  try {
    // Distinct resolved profile_ids from staging — the set-based join maps
    // each to its customer_id in SQL; we only pull the ids here to chunk the
    // UPDATE and keep locks sane.
    console.log("Loading resolved profile ids from staging...");
    const idsRes = await pg.query<{ klaviyo_profile_id: string }>(
      `SELECT DISTINCT klaviyo_profile_id
         FROM klaviyo_profile_staging
        WHERE workspace_id = $1 AND customer_id IS NOT NULL
        ORDER BY klaviyo_profile_id`,
      [WS],
    );
    const profileIds = idsRes.rows.map((r) => r.klaviyo_profile_id);
    const totalBatches = Math.ceil(profileIds.length / PROFILE_BATCH);
    console.log(`Resolved profile ids: ${profileIds.length} → ${totalBatches} batch(es) of ${PROFILE_BATCH}`);

    let totalUpdated = 0;
    let completed = 0;

    // One set-based join-update per profile-id batch:
    //   UPDATE profile_events pe SET customer_id = s.customer_id
    //   FROM klaviyo_profile_staging s
    //   WHERE pe.klaviyo_profile_id = s.klaviyo_profile_id
    //     AND pe.workspace_id = s.workspace_id
    //     AND pe.customer_id IS NULL          -- idempotent, set-when-null
    //     AND pe.klaviyo_profile_id = ANY($2) -- lock-bounding chunk
    for (let i = 0; i < profileIds.length; i += PROFILE_BATCH) {
      const chunk = profileIds.slice(i, i + PROFILE_BATCH);
      const res = await pg.query(
        `UPDATE profile_events pe
            SET customer_id = s.customer_id
           FROM klaviyo_profile_staging s
          WHERE pe.klaviyo_profile_id = s.klaviyo_profile_id
            AND pe.workspace_id = s.workspace_id
            AND s.workspace_id = $1
            AND s.customer_id IS NOT NULL
            AND pe.customer_id IS NULL
            AND pe.klaviyo_profile_id = ANY($2::text[])`,
        [WS, chunk],
      );
      totalUpdated += res.rowCount ?? 0;
      completed++;
      if (completed % 50 === 0 || completed === totalBatches) {
        const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
        console.log(`  ${completed}/${totalBatches} batches | events updated: ${totalUpdated} | ${elapsedMin}min`);
      }
    }

    console.log(`\n✓ DONE — batches=${totalBatches} events_updated=${totalUpdated} time=${((Date.now() - t0) / 60_000).toFixed(1)}min`);
  } finally {
    await pg.end();
  }
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
