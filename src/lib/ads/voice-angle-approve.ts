/**
 * Director approval of customer-voice-mined ad angles → fan into makers.
 *
 * Phase 3 of docs/brain/specs/growth-customer-voice-to-ad-angles.md — the consumer side of the
 * leash class `approve_voice_angle` (declared in [[../agents/growth-director]] Phase 1). The
 * periodic enqueuer scans [[../../tables/product_ad_angles]] for `status='proposed'` rows in
 * workspaces where Growth is the live+autonomous approver, batches them into ONE
 * `growth-voice-angle-approval` agent_jobs target with one pending action per angle, and the
 * Growth director sweep decides per candidate. On approval, this module:
 *   - inserts an [[../../tables/ad_campaigns]] row at `status='ready'` tagged to the angle id
 *     (mirrors `/api/ads/upload-static` — the `static-requested` handler fills ad_videos and
 *     never updates ad_campaigns.status, so the row lands ready-to-test as soon as a static
 *     finishes rendering),
 *   - flips [[../../tables/product_ad_angles]] `status='approved'` + `is_active=true`,
 *   - fires `ad-tool/static-requested` so the makers pipeline ([[../../lifecycles/ad-static]])
 *     renders into [[../../tables/ad_videos]] — the campaign lands on the
 *     [[./ready-to-test]] surface from [[../../specs/growth-adopt-creative-makers]] for a later
 *     promote-to-PAUSED decision,
 *   - writes a [[../../tables/director_activity]] row of `action_kind='approved_voice_angle'`
 *     carrying `{angle_id, source_signal_counts}` so the voice→angle→campaign lineage is
 *     traceable end-to-end.
 *
 * Pure adapter — no growth-director coupling beyond the leash class name, no router knowledge.
 * The caller (the box worker's `runGrowthDirectorJob`) reads the approved pending_actions and
 * invokes `executeApprovedVoiceAngles`; this module never reads `agent_jobs` itself beyond what
 * is handed in.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { inngest } from "@/lib/inngest/client";
import { recordDirectorActivity } from "@/lib/director-activity";
import { loadAutonomyMap, isAutoApprover } from "@/lib/agents/approval-router";
import { readEffectiveOnOff } from "@/lib/control-tower/legacy-switch-compat";

type Admin = ReturnType<typeof createAdminClient>;

/** Injection seam for tests — the live executor sends Inngest events + writes director_activity rows
 * via the real modules; tests pass spies. */
export interface VoiceAngleExecDeps {
  sendInngest?: (event: { name: string; data: unknown }) => Promise<unknown>;
  recordActivity?: (admin: Admin, row: Parameters<typeof recordDirectorActivity>[1]) => Promise<unknown>;
}

const defaultDeps: Required<VoiceAngleExecDeps> = {
  sendInngest: (event) => inngest.send(event) as Promise<unknown>,
  recordActivity: (admin, row) => recordDirectorActivity(admin, row),
};

/** The `pending_actions[].type` for one voice-mined angle awaiting Director sign-off. */
export const APPROVE_VOICE_ANGLE_ACTION_TYPE = "approve_voice_angle" as const;

/** The `director_activity.action_kind` stamped per approved voice-mined angle. */
export const APPROVED_VOICE_ANGLE_ACTION_KIND = "approved_voice_angle" as const;

/** The `agent_jobs.kind` for one batched voice-angle approval target job. */
export const VOICE_ANGLE_APPROVAL_KIND = "growth-voice-angle-approval" as const;

/** The default static archetype the makers pipeline renders for a fanned-out angle. Picked because
 * `testimonial` lands the killer-static archetype at the storefront PDP (no advertorial generation
 * needed) — the simplest legal landing destination for a voice-mined ad. */
export const DEFAULT_VOICE_ANGLE_ARCHETYPE = "testimonial" as const;

/** Per-angle payload one approve action carries. The fragment counts let the director read the
 * voice density without re-loading metadata.mined_from from the angle row. */
export interface ApproveVoiceAnglePayload {
  angle_id: string;
  product_id: string;
  source_signal_counts: { positive: number; objection: number; use_case: number };
  /** The static archetype the makers pipeline renders on approval. */
  archetype: string;
}

export interface BuiltApproveVoiceAngleAction {
  id: string;
  type: typeof APPROVE_VOICE_ANGLE_ACTION_TYPE;
  status: "pending";
  summary: string;
  payload: ApproveVoiceAnglePayload;
}

/** Construct ONE `approve_voice_angle` pending action. The caller assigns the action id. */
export function buildApproveVoiceAngleAction(
  actionId: string,
  payload: ApproveVoiceAnglePayload,
): BuiltApproveVoiceAngleAction {
  const c = payload.source_signal_counts;
  const cited = c.positive + c.objection + c.use_case;
  return {
    id: actionId,
    type: APPROVE_VOICE_ANGLE_ACTION_TYPE,
    status: "pending",
    summary: `Approve voice-mined angle ${payload.angle_id.slice(0, 8)} (cited ${cited} fragments: ${c.positive}p/${c.objection}o/${c.use_case}u) → render ${payload.archetype} static.`,
    payload,
  };
}

/** Loose pending-action shape — matches the worker's MinimalActionLike on the promote sibling. */
interface MinimalActionLike {
  id?: string;
  type?: string;
  status?: string;
  result?: string;
  payload?: unknown;
}
export interface VoiceAngleTargetJob {
  id: string;
  workspace_id: string;
  spec_slug?: string | null;
  pending_actions: MinimalActionLike[] | null;
}

/** Read the payload off a loose pending_actions entry. Returns null on missing/malformed shape. */
export function readApproveVoiceAnglePayload(action: MinimalActionLike): ApproveVoiceAnglePayload | null {
  if (!action.payload || typeof action.payload !== "object") return null;
  const p = action.payload as Record<string, unknown>;
  const angle_id = typeof p.angle_id === "string" ? p.angle_id : "";
  const product_id = typeof p.product_id === "string" ? p.product_id : "";
  if (!angle_id || !product_id) return null;
  const sRaw = p.source_signal_counts;
  const s = sRaw && typeof sRaw === "object" ? (sRaw as Record<string, unknown>) : {};
  return {
    angle_id,
    product_id,
    source_signal_counts: {
      positive: Number(s.positive ?? 0) || 0,
      objection: Number(s.objection ?? 0) || 0,
      use_case: Number(s.use_case ?? 0) || 0,
    },
    archetype: typeof p.archetype === "string" && p.archetype ? p.archetype : DEFAULT_VOICE_ANGLE_ARCHETYPE,
  };
}

/** Resolve a storefront PDP URL for a product. Null when neither domain nor slug is configured. */
async function resolveLandingUrl(
  admin: Admin,
  workspaceId: string,
  productId: string,
): Promise<string | null> {
  try {
    const [{ data: ws }, { data: prod }] = await Promise.all([
      admin
        .from("workspaces")
        .select("storefront_domain, storefront_slug")
        .eq("id", workspaceId)
        .maybeSingle(),
      admin.from("products").select("handle").eq("id", productId).maybeSingle(),
    ]);
    const handle = (prod as { handle?: string | null } | null)?.handle;
    if (!handle) return null;
    const w = ws as { storefront_domain?: string | null; storefront_slug?: string | null } | null;
    if (w?.storefront_domain) return `https://${w.storefront_domain}/${handle}`;
    if (w?.storefront_slug) return `https://shopcx.ai/store/${w.storefront_slug}/${handle}`;
    return null;
  } catch {
    return null;
  }
}

export interface ExecuteApproveVoiceAngleResult {
  ok: boolean;
  reason?: string;
  ad_campaign_id?: string;
}

/**
 * Execute ONE approved `approve_voice_angle` action: insert the campaign at `status='ready'`,
 * flip the angle row to approved + active, fire `ad-tool/static-requested`, and stamp the
 * lineage row. Never throws — failures resolve to `{ok:false, reason}` so the caller can
 * mark the pending action `failed` without aborting the rest of a bundle.
 *
 * Idempotent on a per-angle basis: an angle whose row is already `status='approved'` resolves
 * to `{ok:true, reason:'already_approved'}` (no second campaign is inserted).
 */
export async function executeApproveVoiceAngle(
  admin: Admin,
  opts: { workspaceId: string; specSlug?: string | null; payload: ApproveVoiceAnglePayload; deps?: VoiceAngleExecDeps },
): Promise<ExecuteApproveVoiceAngleResult> {
  const { workspaceId, specSlug, payload } = opts;
  const deps = { ...defaultDeps, ...(opts.deps ?? {}) };
  try {
    // migrate-ad-hoc-kill-switches-to-resolver Phase 1 — the executor reads via the shim: writes
    // to `product_ad_angles.is_active` (the ad-hoc column) still stamp at line ~210 below, but
    // BEFORE any campaign insert or angle flip we consult the union. If the growth-director
    // cascade is OFF, refuse execution — the write is deferred until the cascade clears. Legacy
    // fn returns `true` because voice-angle approval has no pre-existing per-workflow ad-hoc
    // column; only the resolver can pause this executor.
    const cascade = await readEffectiveOnOff("growth-director", async () => true);
    if (cascade.off) {
      const attribution = `${cascade.source}${cascade.offBy ? `:${cascade.offBy}` : ""}`;
      return { ok: false, reason: `kill_switch_off:${attribution}` };
    }
    const { data: angleRow, error: angleErr } = await admin
      .from("product_ad_angles")
      .select("id, status, product_id, hook_one_liner")
      .eq("id", payload.angle_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (angleErr) return { ok: false, reason: `angle_lookup_failed:${angleErr.message}` };
    if (!angleRow) return { ok: false, reason: "angle_not_found" };
    const ar = angleRow as { id: string; status?: string; hook_one_liner?: string | null };
    if (ar.status === "approved") return { ok: true, reason: "already_approved" };

    const landingUrl = await resolveLandingUrl(admin, workspaceId, payload.product_id);
    const namePrefix = ar.hook_one_liner ? String(ar.hook_one_liner).slice(0, 60) : payload.angle_id.slice(0, 8);

    const { data: campaign, error: cErr } = await admin
      .from("ad_campaigns")
      .insert({
        workspace_id: workspaceId,
        product_id: payload.product_id,
        angle_id: payload.angle_id,
        name: `Voice angle · ${namePrefix}`,
        status: "ready",
        landing_url: landingUrl,
      })
      .select("id")
      .maybeSingle();
    if (cErr || !campaign) return { ok: false, reason: `ad_campaigns_insert_failed:${cErr?.message ?? "no_row"}` };
    const adCampaignId = (campaign as { id: string }).id;

    const { error: updErr } = await admin
      .from("product_ad_angles")
      .update({ status: "approved", is_active: true })
      .eq("id", payload.angle_id);
    if (updErr) return { ok: false, reason: `angle_update_failed:${updErr.message}` };

    // Fire the makers pipeline. Best-effort — a transient Inngest hiccup never undoes the
    // approved campaign + angle; a follow-up `POST /api/ads/campaigns/[id]/static` re-requests it.
    try {
      await deps.sendInngest({
        name: "ad-tool/static-requested",
        data: { workspace_id: workspaceId, campaign_id: adCampaignId, archetype: payload.archetype },
      });
    } catch {
      /* persisted state is what matters; the render can be re-triggered */
    }

    await deps.recordActivity(admin, {
      workspaceId,
      directorFunction: "growth",
      actionKind: APPROVED_VOICE_ANGLE_ACTION_KIND,
      specSlug: specSlug ?? null,
      reason: `Approved voice-mined angle (${payload.source_signal_counts.positive}p/${payload.source_signal_counts.objection}o/${payload.source_signal_counts.use_case}u fragments) → ad_campaigns ${adCampaignId.slice(0, 8)} (archetype=${payload.archetype}).`,
      metadata: {
        angle_id: payload.angle_id,
        product_id: payload.product_id,
        ad_campaign_id: adCampaignId,
        archetype: payload.archetype,
        source_signal_counts: payload.source_signal_counts,
        autonomous: true,
      },
    });

    return { ok: true, ad_campaign_id: adCampaignId };
  } catch (err) {
    return { ok: false, reason: errText(err).slice(0, 200) };
  }
}

export interface ExecuteApprovedVoiceAnglesResult {
  ok: boolean;
  executed: { actionId: string; ad_campaign_id?: string; ok: boolean; reason?: string }[];
}

/**
 * Iterate over a target job's `pending_actions` and execute every `approve_voice_angle` whose
 * status is `approved`. Mutates each handled action in place — `status` flips to `done` on success
 * or `failed` on error, and `result` carries the new campaign id or the error reason. The caller
 * is responsible for persisting the mutated array back to `agent_jobs`.
 *
 * Idempotency: a `done` action is skipped on re-run (the loop only acts on `approved`), and a per-
 * angle re-run that hits an already-approved row resolves to a `done` action with `result='already_approved'`.
 */
export async function executeApprovedVoiceAngles(
  admin: Admin,
  target: VoiceAngleTargetJob,
  deps?: VoiceAngleExecDeps,
): Promise<ExecuteApprovedVoiceAnglesResult> {
  const actions = target.pending_actions || [];
  const out: ExecuteApprovedVoiceAnglesResult = { ok: true, executed: [] };
  for (const action of actions) {
    if (action.type !== APPROVE_VOICE_ANGLE_ACTION_TYPE) continue;
    if (action.status !== "approved") continue;
    const actionId = action.id || "";
    const payload = readApproveVoiceAnglePayload(action);
    if (!payload) {
      action.status = "failed";
      action.result = "missing or malformed approve_voice_angle payload";
      out.ok = false;
      out.executed.push({ actionId, ok: false, reason: "malformed_payload" });
      continue;
    }
    const r = await executeApproveVoiceAngle(admin, {
      workspaceId: target.workspace_id,
      specSlug: target.spec_slug ?? null,
      payload,
      deps,
    });
    if (r.ok && r.ad_campaign_id) {
      action.status = "done";
      action.result = `approved → ad_campaigns ${r.ad_campaign_id}`;
      out.executed.push({ actionId, ok: true, ad_campaign_id: r.ad_campaign_id });
    } else if (r.ok) {
      action.status = "done";
      action.result = r.reason || "ok";
      out.executed.push({ actionId, ok: true });
    } else {
      action.status = "failed";
      action.result = `approve failed: ${r.reason ?? "unknown"}`;
      out.ok = false;
      out.executed.push({ actionId, ok: false, reason: r.reason });
    }
  }
  return out;
}

interface ProposedAngleRow {
  id: string;
  workspace_id: string;
  product_id: string;
  metadata: {
    mined_from?: { review_ids?: string[]; cancel_event_ids?: string[]; ticket_ids?: string[] };
  } | null;
}

const ENQUEUE_WORKSPACE_CAP = 20;
const ANGLES_PER_BATCH = 8;
const OPEN_TARGET_STATUSES = ["needs_approval", "queued", "queued_resume", "building"];

/**
 * Periodic enqueuer — find every `status='proposed'` angle in workspaces where Growth is the live+autonomous
 * approver, batch them into ONE `growth-voice-angle-approval` target job per workspace, and surface it as
 * `status='needs_approval'` so the Growth director sweep picks it up via the standing
 * `resolveApprover → routesToGrowth` pipeline. Idempotent: an angle already carried on an OPEN target job
 * (needs_approval / queued / building / queued_resume) is skipped.
 *
 * Dormant (no-op) while Growth isn't live+autonomous — `isAutoApprover('growth', …)` returns false, so
 * `enqueued===0`. Best-effort throughout: a transient read failure logs as zero rather than throwing.
 *
 * Returns the count of target jobs created and the count of actions queued across them, for the worker
 * tick log.
 */
export async function enqueueVoiceAngleApprovalJobs(
  admin: Admin,
): Promise<{ enqueued: number; queued_actions: number }> {
  const autonomy = await loadAutonomyMap();
  if (!isAutoApprover("growth", autonomy)) return { enqueued: 0, queued_actions: 0 };

  const { data: angleData, error: angleErr } = await admin
    .from("product_ad_angles")
    .select("id, workspace_id, product_id, metadata")
    .eq("status", "proposed")
    .order("created_at", { ascending: true })
    .limit(200);
  if (angleErr || !angleData) return { enqueued: 0, queued_actions: 0 };
  const angles = angleData as ProposedAngleRow[];
  if (!angles.length) return { enqueued: 0, queued_actions: 0 };

  // Build the dedup set: angles already queued on an OPEN target job (keyed per workspace so a
  // multi-tenant box never crosses streams).
  const { data: existingJobs } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, status, pending_actions")
    .eq("kind", VOICE_ANGLE_APPROVAL_KIND)
    .in("status", OPEN_TARGET_STATUSES)
    .order("created_at", { ascending: false })
    .limit(500);
  const queuedByWs = new Map<string, Set<string>>();
  for (const j of existingJobs || []) {
    const ws = String((j as { workspace_id: string }).workspace_id);
    const set = queuedByWs.get(ws) ?? new Set<string>();
    for (const a of ((j as { pending_actions: MinimalActionLike[] | null }).pending_actions || [])) {
      const id = (a?.payload as { angle_id?: string } | null)?.angle_id;
      if (id) set.add(String(id));
    }
    queuedByWs.set(ws, set);
  }

  const byWs = new Map<string, ProposedAngleRow[]>();
  for (const r of angles) {
    const queued = queuedByWs.get(r.workspace_id) ?? new Set<string>();
    if (queued.has(r.id)) continue;
    const bucket = byWs.get(r.workspace_id) ?? [];
    if (bucket.length >= ANGLES_PER_BATCH) continue;
    bucket.push(r);
    byWs.set(r.workspace_id, bucket);
  }

  let enqueued = 0;
  let queuedActions = 0;
  let dispatched = 0;
  for (const [ws, rows] of byWs) {
    if (dispatched >= ENQUEUE_WORKSPACE_CAP) break;
    if (!rows.length) continue;
    const actions = rows.map((r, i) => {
      const mined = r.metadata?.mined_from ?? {};
      const counts = {
        positive: Array.isArray(mined.review_ids) ? mined.review_ids.length : 0,
        objection: Array.isArray(mined.cancel_event_ids) ? mined.cancel_event_ids.length : 0,
        use_case: Array.isArray(mined.ticket_ids) ? mined.ticket_ids.length : 0,
      };
      return buildApproveVoiceAngleAction(`va-${r.id.slice(0, 8)}-${i}`, {
        angle_id: r.id,
        product_id: r.product_id,
        source_signal_counts: counts,
        archetype: DEFAULT_VOICE_ANGLE_ARCHETYPE,
      });
    });
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: ws,
      spec_slug: "growth-customer-voice-to-ad-angles",
      kind: VOICE_ANGLE_APPROVAL_KIND,
      status: "needs_approval",
      pending_actions: actions,
      created_by: null,
    });
    if (!error) {
      enqueued += 1;
      queuedActions += actions.length;
      dispatched += 1;
    }
  }
  return { enqueued, queued_actions: queuedActions };
}
