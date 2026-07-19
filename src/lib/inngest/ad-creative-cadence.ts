/**
 * ad-creative-cadence — the daily cron + per-workspace sweep that keeps [[media-buyer-agent|Bianca]]'s
 * ready-to-test bin stocked by enqueuing Dahlia (the [[../libraries/creative-agent|Ad Creative Agent]])
 * for every product whose bin has fallen below the floor.
 *
 * The cron (`ad-creative-cadence-cron`, `0 11 * * *` UTC — ahead of the 13:00 media-buyer cadence so
 * fresh creatives are in the bin before Bianca's pass) SELECTs distinct `workspace_id` from
 * [[../tables/product_ad_angles]] (a product with ad intelligence) and fans out one
 * `growth/ad-creative-cadence-sweep` event per workspace. Each sweep reads the bin depth per product via
 * [[ready-to-test]] `listReadyToTest` and inserts one [[../tables/agent_jobs]] row
 * `kind='ad-creative'` per product below `DEFAULT_BIN_FLOOR`, carrying `instructions.product_id` +
 * `instructions.count` (the deficit) so the runner tops that product up.
 *
 * Idempotency: a sweep skips any product already covered by a NOT-YET-TERMINAL `kind='ad-creative'`
 * job created since the current UTC day start — a same-day re-fire dispatches ZERO new jobs.
 *
 * Self-monitoring: emits an `ad-creative-cadence-cron` heartbeat via [[../libraries/control-tower]]
 * (registered in `src/lib/control-tower/registry.ts`, owner `growth`).
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { listReadyToTest } from "@/lib/ads/ready-to-test";
import { DEFAULT_BIN_FLOOR } from "@/lib/ads/creative-agent";
import { listAdvertisedProductIds } from "@/lib/advertised-products";
import { ACTIVE_MEDIA_BUYER_JOB_STATUSES, utcDayStartIso } from "@/lib/inngest/media-buyer-cadence";
import { resolveEffectiveSwitch, type EffectiveSwitch } from "@/lib/control-tower/kill-switch-resolver";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * ad-creative-box-session-only-retire-deterministic-path Phase 3 (2026-07-19) —
 * enqueue-side kill-switch gate. The daily fan-out consults
 * `resolveEffectiveSwitch('ad-creative')` before inserting ANY `agent_jobs` row so a
 * frozen switch produces nothing (not even a queued row that then sits ineligible).
 * Freeze = produce nothing. The claim-rpc cascade ([[kill_switches]] + `claim_agent_job`)
 * is the defence-in-depth downstream; the enqueue gate closes the gap that let a
 * frozen ad-creative switch produce ~2 queued+claimed jobs on 2026-07-19 despite the
 * `kill_switches` row.
 *
 * Injectable so unit tests can drive both switch states without a live registry / DB.
 * Default is the real `resolveEffectiveSwitch`.
 */
export interface AdCreativeCadenceDeps {
  resolveSwitch?: (nodeId: string) => Promise<EffectiveSwitch>;
}

/** Active `agent_jobs.status` values that still hold a product's cadence slot for today — shared with
 *  the media-buyer cadence (same "unfinished job" definition). */
const ACTIVE_AD_CREATIVE_JOB_STATUSES = ACTIVE_MEDIA_BUYER_JOB_STATUSES;

interface AgentJobRow {
  id: string;
  status: string;
  instructions: string | null;
}

export interface DispatchAdCreativeCadenceResult {
  evaluated: number;
  dispatched: number;
  /** ad-creative-box-session-only-retire-deterministic-path Phase 3 — populated when
   *  the enqueue-side kill-switch gate suppressed the whole sweep so operators can slice
   *  a switch-off no-op apart from an empty-bin no-op. */
  killSwitchOff?: { offBy: string; scope: string; reason: string | null };
}

/**
 * Stable per-product `agent_jobs.spec_slug` for an ad-creative job. The column is
 * `NOT NULL`, so an omitted value blocks the insert (the 2026-07-12 outage,
 * signature `vercel:731cb5703f5f40b6`). One slug per product keeps
 * `agent_jobs_slug_idx (workspace_id, spec_slug, created_at desc)` useful for the
 * Roadmap rollups and gives Dahlia's job a durable subject on the dashboard.
 */
export function adCreativeSpecSlug(productId: string): string {
  return `ad-creative:${productId}`;
}

function readInstructionsProduct(instructions: string | null): string | null {
  if (!instructions) return null;
  try {
    const parsed = JSON.parse(instructions) as { product_id?: unknown };
    return typeof parsed?.product_id === "string" ? parsed.product_id : null;
  } catch {
    return null;
  }
}

/**
 * The PURE per-workspace sweep — for every product with ad intelligence, compute its ready-to-test bin
 * depth, and enqueue an `ad-creative` job (with the deficit) for each product below the floor that
 * isn't already covered by an unfinished job created today. Returns `{evaluated, dispatched}`.
 */
export async function dispatchAdCreativeCadence(
  admin: Admin,
  workspaceId: string,
  binFloor: number = DEFAULT_BIN_FLOOR,
  now: Date = new Date(),
  deps: AdCreativeCadenceDeps = {},
): Promise<DispatchAdCreativeCadenceResult> {
  // ad-creative-box-session-only-retire-deterministic-path Phase 3 — enqueue-side
  // kill-switch gate. Consult resolveEffectiveSwitch BEFORE any DB write so a frozen
  // ad-creative node (or an ancestor: growth department / director:growth) enqueues
  // ZERO jobs. Same fail-open contract as the resolver — an unregistered node treats
  // as ON (mirrors [[../libraries/kill-switch-resolver]]'s missing-row default).
  const resolveSwitch = deps.resolveSwitch ?? resolveEffectiveSwitch;
  const effective = await resolveSwitch("ad-creative");
  if (effective.off) {
    console.log(
      `[ad-creative-cadence] ws=${workspaceId} suppressed by kill_switch — offBy=${effective.offBy} scope=${effective.scope}${effective.reason ? ` reason=${effective.reason}` : ""}`,
    );
    return {
      evaluated: 0,
      dispatched: 0,
      killSwitchOff: { offBy: effective.offBy, scope: effective.scope, reason: effective.reason },
    };
  }
  // Products that have ad intelligence (≥1 angle row) — the candidates to keep stocked.
  const { data: angleRows, error: angErr } = await admin
    .from("product_ad_angles")
    .select("product_id")
    .eq("workspace_id", workspaceId);
  if (angErr) throw new Error(`product_ad_angles read failed: ${angErr.message}`);
  const angleProductIds = [...new Set(((angleRows || []) as Array<{ product_id: string }>).map((r) => r.product_id).filter(Boolean))];
  if (!angleProductIds.length) return { evaluated: 0, dispatched: 0 };
  // Hero-product advertising gate ([[../libraries/advertised-products]]): keep only products the
  // workspace actually advertises (products.is_advertised=true) — attachment SKUs (Tumbler, Sleep
  // Gummies, …) never enter Dahlia's cadence even when a stray product_ad_angles row exists for them.
  const advertisedIds = new Set(await listAdvertisedProductIds(admin, workspaceId));
  const productIds = angleProductIds.filter((id) => advertisedIds.has(id));
  if (!productIds.length) return { evaluated: 0, dispatched: 0 };

  // Bin depth per product: which ready-to-test campaigns belong to each product.
  const { readyToTest } = await listReadyToTest(admin, { workspaceId });
  const readyIds = readyToTest.map((r) => r.ad_campaign_id);
  const depthByProduct = new Map<string, number>();
  if (readyIds.length) {
    const { data: camps } = await admin
      .from("ad_campaigns").select("product_id").eq("workspace_id", workspaceId).in("id", readyIds);
    for (const c of (camps || []) as Array<{ product_id: string | null }>) {
      if (c.product_id) depthByProduct.set(c.product_id, (depthByProduct.get(c.product_id) ?? 0) + 1);
    }
  }

  // Products already covered by an unfinished ad-creative job today.
  const { data: todaysJobs, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, status, instructions")
    .eq("workspace_id", workspaceId)
    .eq("kind", "ad-creative")
    .gte("created_at", utcDayStartIso(now));
  if (jobsErr) throw new Error(`agent_jobs read failed: ${jobsErr.message}`);
  const covered = new Set<string>();
  for (const job of (todaysJobs || []) as AgentJobRow[]) {
    if (!ACTIVE_AD_CREATIVE_JOB_STATUSES.has(job.status)) continue;
    const pid = readInstructionsProduct(job.instructions);
    if (pid) covered.add(pid);
  }

  let dispatched = 0;
  let evaluated = 0;
  for (const productId of productIds) {
    const deficit = binFloor - (depthByProduct.get(productId) ?? 0);
    if (deficit <= 0) continue;
    evaluated++;
    if (covered.has(productId)) continue;
    const { error: insErr } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: adCreativeSpecSlug(productId),
      kind: "ad-creative",
      instructions: JSON.stringify({ product_id: productId, count: deficit }),
    });
    if (insErr) {
      console.error(`[ad-creative-cadence] insert failed ws=${workspaceId} product=${productId}: ${insErr.message}`);
      continue;
    }
    covered.add(productId);
    dispatched++;
  }
  return { evaluated, dispatched };
}

/** Distinct workspace_ids with ≥1 product that has ad intelligence — the cron's fan-out set. */
async function findCadenceWorkspaces(admin: Admin): Promise<string[]> {
  const { data, error } = await admin.from("product_ad_angles").select("workspace_id");
  if (error) throw new Error(`product_ad_angles read failed: ${error.message}`);
  return [...new Set(((data || []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id))];
}

export const adCreativeCadenceCron = inngest.createFunction(
  {
    id: "ad-creative-cadence-cron",
    name: "Growth — ad creative daily cadence",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 11 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const workspaceIds = await step.run("find-cadence-workspaces", async () => findCadenceWorkspaces(admin));
    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({ name: "growth/ad-creative-cadence-sweep", data: { workspace_id: workspaceId, trigger: "cron" } });
      });
    }
    const result = { evaluated: workspaceIds.length, dispatched: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("ad-creative-cadence-cron", { ok: true, produced: result, detail: `fanned out ${result.dispatched} workspace(s)` });
    });
    return result;
  },
);

export const adCreativeCadenceSweep = inngest.createFunction(
  {
    id: "ad-creative-cadence-sweep",
    name: "Growth — ad creative per-workspace cadence sweep",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/ad-creative-cadence-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string; trigger?: "cron" | "manual" };
    const result = await step.run("dispatch-ad-creative-jobs", async () => {
      const admin = createAdminClient();
      return dispatchAdCreativeCadence(admin, workspace_id);
    });
    console.log(`[ad-creative-cadence] ws=${workspace_id} evaluated=${result.evaluated} dispatched=${result.dispatched}`);
    return { status: "complete", ...result };
  },
);
