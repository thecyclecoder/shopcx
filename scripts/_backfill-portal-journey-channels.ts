/**
 * One-time backfill for journeys-enrolled-on-portal-so-sol-june-stop-wrong-escalating.
 *
 * Symptom: Sol/June's channel-eligibility filter (`channelMatches` in
 * src/lib/cx-agent-sdk.ts) only surfaces a journey on a portal ticket when
 * 'portal' is in `journey_definitions.channels`. Portal delivery is fully
 * built (src/lib/journey-delivery.ts's `effectiveChannel === 'portal'`
 * branch inserts a CTA bubble in the portal thread + emails the customer),
 * but nearly every self-service journey seeded before 2026-07-30 was seeded
 * with `channels := ['email','chat','sms']` (or ['email','chat','sms','meta_dm']),
 * omitting 'portal'. On a portal ticket the agents therefore never see a
 * resolvable self-service option and escalate to the founder — which is
 * exactly how Natalie's medical-hardship cancel wrongly escalated on
 * 2026-07-30 ('no sanctioned path, cancel journey isn't enrolled for portal')
 * when the correct answer was a one-tap cancel journey.
 *
 * Cancel Subscription was already hand-added to portal on 2026-07-30; this
 * backfill closes the same gap for the remaining portal-deliverable
 * self-service journeys (compare-and-set so the hand-fix is a no-op for it).
 *
 * Scope (deliberately narrow — leave crisis / marketing / dunning journeys
 * untouched):
 *   workspace_id = <SUPERFOODS>
 *   AND is_active = true
 *   AND trigger_intent ∈ PORTAL_DELIVERABLE_JOURNEY_INTENTS
 *       (canonical list — src/lib/journey-delivery.ts)
 *
 * Action per row: read the existing channels array, add 'portal' iff absent,
 * write back with a compare-and-set on the read-time channels value so an
 * intervening human edit isn't clobbered. If 'portal' is already present the
 * row is skipped (no-op).
 *
 * Do NOT touch the Crisis Tier journeys — they are deliberately email-only
 * (proactive outreach, not portal self-service) and their trigger_intents
 * are absent from PORTAL_DELIVERABLE_JOURNEY_INTENTS.
 *
 * Dry-run by default. Prints the plan + a per-row line. Pass `--apply` to
 * actually write.
 *   npx tsx scripts/_backfill-portal-journey-channels.ts            # dry-run
 *   npx tsx scripts/_backfill-portal-journey-channels.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";
import { PORTAL_DELIVERABLE_JOURNEY_INTENTS } from "../src/lib/journey-delivery";

const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  const { data: before, error: readErr } = await admin
    .from("journey_definitions")
    .select("id, slug, name, trigger_intent, channels, is_active")
    .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
    .eq("is_active", true)
    .in("trigger_intent", [...PORTAL_DELIVERABLE_JOURNEY_INTENTS])
    .order("slug", { ascending: true });
  if (readErr) {
    console.error("read_failed", readErr.message);
    process.exit(1);
  }
  const rows = (before ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    trigger_intent: string;
    channels: string[] | null;
    is_active: boolean;
  }>;

  console.log(`portal_journey_channels_backfill — ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  workspace: ${SUPERFOODS_WORKSPACE_ID}`);
  console.log(`  scope:     is_active=true AND trigger_intent ∈ [${PORTAL_DELIVERABLE_JOURNEY_INTENTS.join(", ")}]`);
  console.log(`  candidates: ${rows.length} row(s)`);

  const toWrite = rows.filter((r) => !(r.channels ?? []).includes("portal"));
  const alreadyPortal = rows.filter((r) => (r.channels ?? []).includes("portal"));

  for (const r of alreadyPortal) {
    console.log(`   ✓ ${r.slug.padEnd(24)} intent=${r.trigger_intent.padEnd(20)} channels=${JSON.stringify(r.channels ?? [])}  (already portal — no-op)`);
  }
  for (const r of toWrite) {
    console.log(`   + ${r.slug.padEnd(24)} intent=${r.trigger_intent.padEnd(20)} channels=${JSON.stringify(r.channels ?? [])}  → adding 'portal'`);
  }

  if (!toWrite.length) {
    console.log("nothing to backfill.");
    return;
  }

  if (!apply) {
    console.log("\n(dry-run) — rerun with --apply to add 'portal' to the channels above.");
    return;
  }

  // Compare-and-set per row: only write when the current channels array still
  // matches the read-time value (no intervening human edit) and 'portal' is
  // still absent. An intervening edit is respected — the row is skipped and
  // reported in the after-count.
  let changed = 0;
  for (const r of toWrite) {
    const nextChannels = [...(r.channels ?? []), "portal"];
    const { data: upd, error: updErr } = await admin
      .from("journey_definitions")
      .update({ channels: nextChannels })
      .eq("id", r.id)
      .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
      .eq("is_active", true)
      // Compare-and-set on the read-time channels array. If a human hand-added
      // a channel between the read and this write, we bail rather than clobber.
      .eq("channels", r.channels ?? [])
      .select("id");
    if (updErr) {
      console.error(`  ! ${r.slug}: update_failed — ${updErr.message}`);
      continue;
    }
    const n = ((upd ?? []) as Array<{ id: string }>).length;
    if (n === 1) {
      changed += 1;
      console.log(`   ✓ ${r.slug}: 'portal' added`);
    } else {
      console.log(`   … ${r.slug}: skipped (channels changed under us — no-op)`);
    }
  }
  console.log(`  updated:   ${changed} of ${toWrite.length} row(s)`);

  // Confidence: re-read and confirm every row now includes portal.
  const { data: after } = await admin
    .from("journey_definitions")
    .select("id, slug, channels")
    .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
    .eq("is_active", true)
    .in("trigger_intent", [...PORTAL_DELIVERABLE_JOURNEY_INTENTS]);
  const missing = ((after ?? []) as Array<{ slug: string; channels: string[] | null }>)
    .filter((r) => !(r.channels ?? []).includes("portal"));
  console.log(`  after:     ${missing.length} row(s) still missing 'portal' (should be 0)`);
  if (missing.length) {
    for (const r of missing) console.warn(`   ! ${r.slug}: still missing portal — investigate before rerunning`);
  }
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
