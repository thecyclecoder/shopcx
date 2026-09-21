/**
 * customer-tax-exemptions SDK — the single sanctioned read/write surface for
 * `public.customer_tax_exemptions`.
 *
 * Phase 1 of [[../../docs/brain/specs/a-customer-can-be-recorded-as-sales-tax-exempt.md]].
 *
 * WHY. A customer asked on 2026-08-07 how to apply Oklahoma's sales-tax exemption for one-hundred-
 * percent disabled veterans. We answered we could not; the answer has changed now that our own
 * tax engine is live and Avalara identifies the buyer by their email (the same key it uses for a
 * stored exemption). This SDK is where the exemption record lives so Phase 2 (avalara-cart +
 * avalara-subscription) can thread it into every `transactions/create` /
 * `transactions/createoradjust` call, and Phase 3 (support-side founder-approved action) can
 * record a certificate from a ticket.
 *
 * ⚠️ CLAUDE.md § Raw `.from(...)` with no SDK → STOP. Every read/write to
 * `public.customer_tax_exemptions` MUST go through this file — the shape gotchas (partial
 * UNIQUE on `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL`, region uppercased,
 * expiry honored) all live inside `resolveCustomerTaxExemption` / `recordCustomerTaxExemption` /
 * `revokeCustomerTaxExemption` so no caller repeats them. Enforced by
 * `scripts/_check-customer-tax-exemptions-sdk-compliance.ts` (wired into `predeploy`).
 *
 * See [[../../docs/brain/tables/customer_tax_exemptions.md]].
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Row shape mirrors `public.customer_tax_exemptions`. */
export interface CustomerTaxExemptionRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  exemption_no: string;
  entity_use_code: string;
  jurisdiction_region: string;
  expires_at: string | null;
  notes: string | null;
  recorded_by: string | null;
  recorded_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  created_at: string;
}

/**
 * The projection Phase 2 threads into Avalara — just the two fields the wrapper's
 * `CreateTransactionParams` extension carries (`exemptionNo` + `entityUseCode`). Avalara keys the
 * exemption by the buyer's email (the `customerCode` we already send); the SDK does not
 * re-transmit the customer's email here.
 */
export interface CustomerTaxExemptionForAvalara {
  /** Certificate/permit reference — Avalara's `exemptionNo` request field. */
  exemptionNo: string;
  /** Avalara reason code — Avalara's `entityUseCode` request field. */
  entityUseCode: string;
  /**
   * The two-letter region the certificate covers. Phase 2's cache-hash MUST include this so a
   * quote for a TX shipment does not reuse a cached OK-exempt quote for the same customer.
   */
  jurisdictionRegion: string;
}

const COLS =
  "id, workspace_id, customer_id, exemption_no, entity_use_code, jurisdiction_region, expires_at, notes, recorded_by, recorded_at, revoked_at, revoked_by, revoked_reason, created_at";

/**
 * The Phase-2 reader — the single entry point avalara-cart and avalara-subscription reach for
 * when building a transaction body. Returns the LIVE certificate matching the ship-to region, or
 * null when no live matching certificate exists (which is what an unregistered buyer looks like:
 * Avalara falls through to computing tax the normal way).
 *
 * "Live" means: `revoked_at IS NULL` AND (`expires_at IS NULL` OR `expires_at > now()`) — so an
 * expired certificate is treated as absent, never as an exemption. Region matching is exact on
 * the uppercased two-letter code; a caller shipping to OK will not accidentally hit a TX
 * certificate for the same customer.
 *
 * The partial-UNIQUE on (customer_id, jurisdiction_region) WHERE revoked_at IS NULL guarantees at
 * most one live row per (customer, region); the ORDER BY + LIMIT 1 belt-and-suspenders picks the
 * most-recently-recorded live row in case the invariant is ever bypassed (data-import edge case).
 *
 * The SDK does the freshness check in code, not just via `.gt('expires_at', now())`, so a row
 * with `expires_at = null` (no expiry) is included — Supabase's PostgREST `.or()` builder for
 * "is null OR gt" would be brittle here and easy to mis-write.
 */
export async function resolveCustomerTaxExemption(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  shipToRegion: string,
): Promise<CustomerTaxExemptionForAvalara | null> {
  const region = (shipToRegion ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return null;
  const { data, error } = await admin
    .from("customer_tax_exemptions")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .eq("jurisdiction_region", region)
    .is("revoked_at", null)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(
      `customer-tax-exemptions.resolveCustomerTaxExemption(${customerId}, ${region}): ${error.message}`,
    );
  }
  if (!data) return null;
  const row = data as CustomerTaxExemptionRow;
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) {
    return null;
  }
  return {
    exemptionNo: row.exemption_no,
    entityUseCode: row.entity_use_code,
    jurisdictionRegion: row.jurisdiction_region,
  };
}

/**
 * List every exemption on record for a customer, live and historical, most-recently-recorded
 * first. The support UI (and the CFO audit path) reads this — it includes revoked / expired rows
 * so a reviewer can retrace what was in effect when a given transaction was quoted.
 */
export async function listCustomerTaxExemptions(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CustomerTaxExemptionRow[]> {
  const { data, error } = await admin
    .from("customer_tax_exemptions")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .order("recorded_at", { ascending: false });
  if (error) {
    throw new Error(
      `customer-tax-exemptions.listCustomerTaxExemptions(${customerId}): ${error.message}`,
    );
  }
  return (data as CustomerTaxExemptionRow[] | null) ?? [];
}

/** Typed rejection raised by the writer/revoker for a shape or state violation. */
export class CustomerTaxExemptionError extends Error {
  readonly code:
    | "exemption_no_missing"
    | "entity_use_code_missing"
    | "region_invalid"
    | "expires_at_invalid"
    | "expires_at_in_past"
    | "row_not_found"
    | "already_revoked";
  constructor(code: CustomerTaxExemptionError["code"], message: string) {
    super(message);
    this.name = "CustomerTaxExemptionError";
    this.code = code;
  }
}

/**
 * The Phase-3 writer — records a new exemption certificate for a customer. Because this decides
 * whether we collect tax, Phase 3 gates the CALL on the founder-approval pattern (never a silent
 * auto-record). The writer itself validates the shape and enforces the invariants; the approval
 * gate lives at the action layer.
 *
 * If a live certificate for the same (customer, region) exists, the caller MUST call
 * {@link revokeCustomerTaxExemption} first — the partial UNIQUE will otherwise error 23505. This
 * shape is deliberate: we want the audit trail to show a supersede, not a silent overwrite.
 */
export async function recordCustomerTaxExemption(
  admin: Admin,
  input: {
    workspace_id: string;
    customer_id: string;
    exemption_no: string;
    entity_use_code: string;
    jurisdiction_region: string;
    expires_at?: string | null;
    notes?: string | null;
    recorded_by?: string | null;
  },
): Promise<CustomerTaxExemptionRow> {
  const exemptionNo = (input.exemption_no ?? "").trim();
  if (exemptionNo.length === 0) {
    throw new CustomerTaxExemptionError(
      "exemption_no_missing",
      "exemption_no is required and must be a non-empty string",
    );
  }
  const entityUseCode = (input.entity_use_code ?? "").trim();
  if (entityUseCode.length === 0) {
    throw new CustomerTaxExemptionError(
      "entity_use_code_missing",
      "entity_use_code is required and must be a non-empty string — verify against Avalara's definitions endpoint",
    );
  }
  const region = (input.jurisdiction_region ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) {
    throw new CustomerTaxExemptionError(
      "region_invalid",
      "jurisdiction_region must be a two-letter region code (e.g. 'OK')",
    );
  }
  let expiresAtIso: string | null = null;
  if (input.expires_at !== undefined && input.expires_at !== null && input.expires_at !== "") {
    const parsed = new Date(input.expires_at);
    if (Number.isNaN(parsed.getTime())) {
      throw new CustomerTaxExemptionError(
        "expires_at_invalid",
        "expires_at must be a parseable ISO timestamp",
      );
    }
    if (parsed.getTime() <= Date.now()) {
      throw new CustomerTaxExemptionError(
        "expires_at_in_past",
        "expires_at cannot be in the past — recording an already-expired certificate would zero nothing and clutter the audit trail",
      );
    }
    expiresAtIso = parsed.toISOString();
  }
  const { data, error } = await admin
    .from("customer_tax_exemptions")
    .insert({
      workspace_id: input.workspace_id,
      customer_id: input.customer_id,
      exemption_no: exemptionNo,
      entity_use_code: entityUseCode,
      jurisdiction_region: region,
      expires_at: expiresAtIso,
      notes: input.notes ?? null,
      recorded_by: input.recorded_by ?? null,
    })
    .select(COLS)
    .single();
  if (error) throw error;
  return data as CustomerTaxExemptionRow;
}

/**
 * Revoke a live certificate — the SDK-only path a superseding record calls before inserting the
 * new row (never an in-place UPDATE, so the audit trail shows the revoke). Compare-and-set on
 * `revoked_at IS NULL` so a concurrent second revoke is a typed rejection, not a silent no-op.
 */
export async function revokeCustomerTaxExemption(
  admin: Admin,
  input: {
    workspace_id: string;
    id: string;
    revoked_by?: string | null;
    revoked_reason?: string | null;
  },
): Promise<CustomerTaxExemptionRow> {
  const { data, error } = await admin
    .from("customer_tax_exemptions")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: input.revoked_by ?? null,
      revoked_reason: input.revoked_reason ?? null,
    })
    .eq("workspace_id", input.workspace_id)
    .eq("id", input.id)
    .is("revoked_at", null)
    .select(COLS)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new CustomerTaxExemptionError(
      "already_revoked",
      `customer_tax_exemptions.id=${input.id} is not a live row in workspace ${input.workspace_id} (already revoked, or never existed)`,
    );
  }
  return data as CustomerTaxExemptionRow;
}
