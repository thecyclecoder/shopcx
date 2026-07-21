/**
 * One-off runtime application of [[docs/brain/specs/director-dismiss-park-and-short-circuit-spec-amazing-creamer-apply.md]].
 *
 * Two actions on the live state, RE-PROBING first per the spec's caveat that either may already be moot:
 *   1. dismiss-park on the Amazing Creamer product-seed `agent_jobs` row (only if still `needs_attention`).
 *   2. spec-status shortCircuit on `box-product-seeding` (only if `spec_card_state.status` is not already `shipped`).
 *
 * Both halves are independent — a failure or moot result in one does not block the other. Every branch
 * (landed action, moot no-op, lookup miss) writes a `director_activity` row capturing the live state so
 * the apply is auditable end-to-end. `director_function` is `platform` (the owner of this spec + the
 * parent capability spec).
 *
 * Idempotent: a re-run finds the park already dismissed (skips it as moot) and the spec already shipped
 * (skips it as moot). Safe to run multiple times.
 *
 * Run: `npx tsx scripts/apply-amazing-creamer-dismiss-park-and-short-circuit.ts`
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company workspace
const DIRECTOR_FUNCTION = "platform";
const SPEC_SLUG_BOX_PRODUCT_SEEDING = "box-product-seeding";
const APPLY_SPEC_SLUG = "director-dismiss-park-and-short-circuit-spec-amazing-creamer-apply";

const DISMISS_REASON =
  "underlying spec short-circuited — CEO 2026-06-24, see box-product-seeding.";
const SHORT_CIRCUIT_REASON =
  "no longer needed — CEO 2026-06-24, retained as reference: seed-product skill + this spec + brain pages stay grep-able for future product seeding.";

/** Locate the Amazing Creamer product. Tries `handle='amazing-creamer'` first, then a title ILIKE fallback
 *  (the production handle could differ from the brain's canonical slug — don't fail the whole apply on it). */
async function findCreamerProduct(admin: ReturnType<typeof createAdminClient>) {
  const byHandle = await admin
    .from("products")
    .select("id, handle, title")
    .eq("workspace_id", WS)
    .eq("handle", "amazing-creamer")
    .maybeSingle();
  if (byHandle.data) return byHandle.data;
  if (byHandle.error) console.warn(`[products handle lookup] ${byHandle.error.message}`);
  const byTitle = await admin
    .from("products")
    .select("id, handle, title")
    .eq("workspace_id", WS)
    .ilike("title", "%amazing creamer%")
    .limit(1);
  if (byTitle.error) console.warn(`[products title lookup] ${byTitle.error.message}`);
  return byTitle.data?.[0] ?? null;
}

async function applyDismissPark(admin: ReturnType<typeof createAdminClient>) {
  const { recordDirectorActivity } = await import("../src/lib/director-activity");
  const product = await findCreamerProduct(admin);
  if (!product) {
    console.log("✓ dismiss-park: Amazing Creamer product not found in Superfoods workspace — moot");
    await recordDirectorActivity(admin, {
      workspaceId: WS,
      directorFunction: DIRECTOR_FUNCTION,
      actionKind: "dismiss_park_noop",
      specSlug: SPEC_SLUG_BOX_PRODUCT_SEEDING,
      reason:
        "Amazing Creamer product not found in workspace at apply time — no product-seed park to dismiss.",
      metadata: {
        product_handle_searched: "amazing-creamer",
        spec_slug: APPLY_SPEC_SLUG,
        autonomous: true,
      },
    });
    return;
  }
  console.log(`product: ${product.id} · ${product.title} (handle=${product.handle ?? "?"})`);

  const { data: parkedJobs, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, status, needs_attention_class, kind, created_at, updated_at")
    .eq("workspace_id", WS)
    .eq("kind", "product-seed")
    .eq("spec_slug", product.id)
    .eq("status", "needs_attention")
    .order("created_at", { ascending: false });
  if (jobsErr) {
    console.warn(`[agent_jobs lookup] ${jobsErr.message}`);
  }

  if (!parkedJobs || parkedJobs.length === 0) {
    const { data: recent } = await admin
      .from("agent_jobs")
      .select("id, status, needs_attention_class, updated_at")
      .eq("workspace_id", WS)
      .eq("kind", "product-seed")
      .eq("spec_slug", product.id)
      .order("created_at", { ascending: false })
      .limit(3);
    console.log("✓ dismiss-park: no needs_attention row to dismiss (moot)");
    console.log(`  recent product-seed rows for ${product.title}:`, JSON.stringify(recent ?? [], null, 2));
    await recordDirectorActivity(admin, {
      workspaceId: WS,
      directorFunction: DIRECTOR_FUNCTION,
      actionKind: "dismiss_park_noop",
      specSlug: SPEC_SLUG_BOX_PRODUCT_SEEDING,
      reason:
        "Amazing Creamer product-seed park already cleared at apply time — no needs_attention row to dismiss.",
      metadata: {
        product_id: product.id,
        product_handle: product.handle,
        recent_jobs: recent ?? [],
        spec_slug: APPLY_SPEC_SLUG,
        autonomous: true,
      },
    });
    return;
  }

  for (const job of parkedJobs) {
    const priorClass = (job.needs_attention_class as string | null) ?? null;
    const { error: updErr } = await admin
      .from("agent_jobs")
      .update({
        status: "dismissed",
        needs_attention_class: "dismissed_by_director",
        error: `dismissed by ${DIRECTOR_FUNCTION} director: ${DISMISS_REASON}`.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "needs_attention");
    if (updErr) {
      console.error(`[agent_jobs update ${job.id}] ${updErr.message}`);
      continue;
    }
    console.log(`✓ dismiss-park: dismissed ${job.id} (prior class: ${priorClass ?? "null"})`);
    await recordDirectorActivity(admin, {
      workspaceId: WS,
      directorFunction: DIRECTOR_FUNCTION,
      actionKind: "dismissed_park",
      specSlug: SPEC_SLUG_BOX_PRODUCT_SEEDING,
      reason: DISMISS_REASON,
      metadata: {
        job_id: job.id,
        spec_slug: SPEC_SLUG_BOX_PRODUCT_SEEDING,
        prior_class: priorClass,
        target_kind: job.kind,
        auto_applied: true,
        autonomous: true,
        applied_via: APPLY_SPEC_SLUG,
      },
    });
  }
}

async function applyShortCircuit(admin: ReturnType<typeof createAdminClient>) {
  const { recordDirectorActivity } = await import("../src/lib/director-activity");
  const cs = await import("../src/lib/spec-card-state");
  const states = await cs.getSpecCardStates(WS);
  const existing = states[SPEC_SLUG_BOX_PRODUCT_SEEDING];
  const liveStatus = existing?.status ?? null;
  const priorShortCircuit = existing?.flags?.short_circuit === true;

  if (liveStatus === "shipped") {
    console.log(
      `✓ spec-status: ${SPEC_SLUG_BOX_PRODUCT_SEEDING} already shipped (short_circuit=${priorShortCircuit}) — moot`,
    );
    await recordDirectorActivity(admin, {
      workspaceId: WS,
      directorFunction: DIRECTOR_FUNCTION,
      actionKind: "spec_status_noop",
      specSlug: SPEC_SLUG_BOX_PRODUCT_SEEDING,
      reason:
        "box-product-seeding already shipped at apply time (folded via the normal path 2026-06-22) — shortCircuit flip is moot.",
      metadata: {
        live_status: liveStatus,
        live_short_circuit: priorShortCircuit,
        intended_short_circuit: true,
        intended_reason: SHORT_CIRCUIT_REASON,
        spec_slug: APPLY_SPEC_SLUG,
        autonomous: true,
      },
    });
    return;
  }

  const actor = `director:${DIRECTOR_FUNCTION}`;
  const audit = { actor, reason: SHORT_CIRCUIT_REASON };
  const priorPhases = (existing?.phase_states ?? []) as cs.SpecCardPhaseState[];
  await cs.markSpecCardStatus(WS, SPEC_SLUG_BOX_PRODUCT_SEEDING, "shipped", priorPhases, audit);
  await cs.markSpecCardShortCircuit(WS, SPEC_SLUG_BOX_PRODUCT_SEEDING, true, SHORT_CIRCUIT_REASON);
  console.log(
    `✓ spec-status: flipped ${SPEC_SLUG_BOX_PRODUCT_SEEDING} → shipped + short_circuit=true (was ${liveStatus ?? "absent"})`,
  );
  await recordDirectorActivity(admin, {
    workspaceId: WS,
    directorFunction: DIRECTOR_FUNCTION,
    actionKind: "spec_status_flipped",
    specSlug: SPEC_SLUG_BOX_PRODUCT_SEEDING,
    reason: SHORT_CIRCUIT_REASON,
    metadata: {
      applied: ["status → shipped", `short-circuit=true (reason: ${SHORT_CIRCUIT_REASON})`],
      auto_applied: true,
      short_circuit: true,
      prior_status: liveStatus,
      applied_via: APPLY_SPEC_SLUG,
    },
  });
}

async function main() {
  const admin = createAdminClient();
  try {
    await applyDismissPark(admin);
  } catch (e) {
    console.error("[dismiss-park] failed:", errText(e));
  }
  try {
    await applyShortCircuit(admin);
  } catch (e) {
    console.error("[spec-status short-circuit] failed:", errText(e));
  }
  console.log("\n✓ apply complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
