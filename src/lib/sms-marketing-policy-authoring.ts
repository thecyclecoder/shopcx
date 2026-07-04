/**
 * sms-marketing-policy-authoring — the WRITE side of [[sms_marketing_policy]], the CMO-side
 * mirror of [[storefront-optimizer-policy-authoring]]. Iris (CMO) uses this to author +
 * activate the SMS marketing agent's bounded proxy (docs/brain/inngest/sms-marketing.md).
 *
 * The agent + cron stay READ-ONLY over the policy (see loadSmsPolicy in [[sms-marketing-agent]]);
 * only Iris (or a human via the dashboard) writes here. Two halves of the activation leash:
 *
 *   1. authorSmsPolicy — upsert the workspace's single policy row at the unique (workspace_id)
 *      key with active=false. Author-only: never flips the on-switch. Carries the cadence
 *      guardrails (weekly cap, send windows, segment scope, theme wiring) + the rationale.
 *   2. activateSmsPolicy — flip active=false → true. The reversible on/off the next cron tick
 *      re-reads. Fails if no row exists (author first).
 *
 * Both are best-effort + return a typed result (no throws) so a director/box lane that also
 * writes a director_activity row never loses the audit line to an exception. Mirrors
 * src/lib/storefront/optimizer-policy-authoring.ts exactly.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** A candidate send window the agent may fire in. weekday: 0=Sun … 6=Sat (workspace-tz). */
export interface SmsSendWindow {
  weekday: number;
  hour: number;
  theme: string; // 'vip' | 'weekend'
}

/** Per-theme offer wiring — the pre-existing Shopify code + landing collection + label. */
export interface SmsThemeOffer {
  code: string;
  collection: string;
  discount_label: string;
}

/** The editable guardrails the agent optimizes within — the bounded proxy. All OPTIONAL so a
 *  partial author lets the column defaults fill the rest on upsert. */
export interface SmsPolicyGuardrails {
  weekly_send_cap?: number;
  min_days_between_sends?: number;
  send_windows?: SmsSendWindow[];
  segment_scope?: string[];
  theme_config?: Record<string, SmsThemeOffer>;
}

export interface AuthorSmsPolicyInput {
  workspaceId: string;
  guardrails?: SmsPolicyGuardrails;
  /** Iris's WHY — surfaced on the brief + the audit row. */
  rationale: string;
  /** An auth.users.id (the human/agent stamping `updated_by`). */
  createdBy?: string | null;
}

export interface AuthorSmsPolicyResult {
  ok: boolean;
  policyId?: string;
  detail: string;
}

/**
 * Upsert the workspace's single SMS marketing policy row at unique (workspace_id) with
 * active=false. Author-only — the on-switch stays OFF; activateSmsPolicy is the separate flip.
 * Idempotent at the workspace grain. Stamps created_by='agent' (every call comes from Iris's
 * autonomous lane; the human-author path via the dashboard writes 'human').
 */
export async function authorSmsPolicy(
  admin: Admin,
  input: AuthorSmsPolicyInput,
): Promise<AuthorSmsPolicyResult> {
  if (!input.workspaceId) return { ok: false, detail: "authorSmsPolicy: workspaceId required" };
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    active: false,
    created_by: "agent",
    updated_by: input.createdBy ?? null,
    rationale: input.rationale ?? null,
    updated_at: now,
  };
  const g = input.guardrails ?? {};
  if (typeof g.weekly_send_cap === "number") row.weekly_send_cap = g.weekly_send_cap;
  if (typeof g.min_days_between_sends === "number") row.min_days_between_sends = g.min_days_between_sends;
  if (Array.isArray(g.send_windows)) row.send_windows = g.send_windows;
  if (Array.isArray(g.segment_scope)) row.segment_scope = g.segment_scope;
  if (g.theme_config && typeof g.theme_config === "object") row.theme_config = g.theme_config;

  const { data, error } = await admin
    .from("sms_marketing_policy")
    .upsert(row, { onConflict: "workspace_id" })
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, detail: `authorSmsPolicy upsert failed: ${error.message}` };
  return {
    ok: true,
    policyId: (data as { id?: string } | null)?.id,
    detail: `upserted sms_marketing_policy for workspace ${input.workspaceId} (active=false)`,
  };
}

export interface ActivateSmsPolicyInput {
  workspaceId: string;
  activatedBy?: string | null;
}

export interface ActivateSmsPolicyResult {
  ok: boolean;
  /** True when this call FLIPPED false→true; false when already on or no row exists. */
  flipped: boolean;
  detail: string;
}

/**
 * Flip the workspace's SMS marketing policy active=false → true. The reversible on/off the next
 * cron tick re-reads. Idempotent (already-on ⇒ {ok:true, flipped:false}). Fails if no row exists
 * — call authorSmsPolicy first.
 */
export async function activateSmsPolicy(
  admin: Admin,
  input: ActivateSmsPolicyInput,
): Promise<ActivateSmsPolicyResult> {
  if (!input.workspaceId) return { ok: false, flipped: false, detail: "activateSmsPolicy: workspaceId required" };
  const { data: existing, error: loadErr } = await admin
    .from("sms_marketing_policy")
    .select("id, active")
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (loadErr) return { ok: false, flipped: false, detail: `activateSmsPolicy load failed: ${loadErr.message}` };
  if (!existing) {
    return { ok: false, flipped: false, detail: `no sms_marketing_policy row for workspace ${input.workspaceId} — call authorSmsPolicy first` };
  }
  if (existing.active === true) {
    return { ok: true, flipped: false, detail: `sms_marketing_policy already active for workspace ${input.workspaceId} — idempotent no-op` };
  }
  const now = new Date().toISOString();
  const { error: upErr } = await admin
    .from("sms_marketing_policy")
    .update({ active: true, updated_by: input.activatedBy ?? null, updated_at: now })
    .eq("workspace_id", input.workspaceId);
  if (upErr) return { ok: false, flipped: false, detail: `activateSmsPolicy update failed: ${upErr.message}` };
  return { ok: true, flipped: true, detail: `activated sms_marketing_policy for workspace ${input.workspaceId}` };
}
