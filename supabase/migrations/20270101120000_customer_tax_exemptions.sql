-- customer_tax_exemptions — the durable record of a customer's sales-tax exemption.
--
-- Phase 1 of docs/brain/specs/a-customer-can-be-recorded-as-sales-tax-exempt.md.
--
-- WHY. A customer asked on 2026-08-07 how to apply Oklahoma's sales-tax exemption for one-hundred-
-- percent disabled veterans to her subscription. We answered three days later that we cannot: our
-- billing calculates tax from the shipping address and there is no way to record an exemption
-- certificate or mark an account exempt. That answer was true when we sent it. It has changed —
-- our own tax engine is now live in production and identifies the buyer by their email address on
-- each transaction, which is exactly the key Avalara uses to apply a stored exemption. Until we
-- honor an exemption, we are collecting tax from buyers who are entitled not to pay it.
--
-- SHAPE. One row per (customer, certificate) — not columns on public.customers, because a buyer can
-- hold more than one certificate (different states) and an expired certificate must be RETAINED
-- for audit rather than overwritten. `exemption_no` is the certificate/permit reference, and
-- `entity_use_code` is Avalara's stable reason code for WHY the buyer is exempt (verified against
-- the definitions endpoint, never guessed — the trap Avalara's silent-degrade of an unrecognized
-- code documents on docs/brain/integrations/avalara.md). `jurisdiction_region` is the two-letter
-- state / province the certificate covers ('OK' for the veterans certificate). `expires_at` is
-- optional; when set, Phase 2's resolver refuses to zero tax after that instant.
--
-- LIVENESS. A partial UNIQUE index on (workspace_id, customer_id, jurisdiction_region) WHERE
-- revoked_at IS NULL guarantees at most one LIVE certificate per customer + region. A superseding
-- certificate calls the SDK's revoke first, then insert — never an in-place UPDATE. Revoked and
-- expired rows are RETAINED for the audit trail (the spec's "auditable" requirement).
--
-- PROVENANCE. `recorded_by` names the workspace member who recorded the certificate; Phase 3's
-- founder-approval action stamps this from the approving user's UUID. `recorded_at` is server-set.
-- Nothing about this table is written by the customer — recording an exemption is a support-side
-- action because the certificate is the evidence.

CREATE TABLE IF NOT EXISTS public.customer_tax_exemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  -- The certificate/permit reference the state issued the buyer (Avalara `exemptionNo`).
  exemption_no text NOT NULL,
  -- Avalara `entityUseCode` — a stable reason code for WHY the buyer is exempt. Must match
  -- Avalara's definitions endpoint or Avalara silently downgrades the transaction to fully
  -- taxable with a 200 OK (docs/brain/integrations/avalara.md § Silent-degrade trap).
  entity_use_code text NOT NULL,
  -- Two-letter region (state / province) the certificate covers, e.g. 'OK' for Oklahoma. Phase
  -- 2's resolver keys off this + the ship-to region so an OK certificate does not zero a TX
  -- shipment. Uppercased at the SDK writer; the CHECK below enforces the same.
  jurisdiction_region text NOT NULL,
  -- Optional expiry — a state-issued certificate frequently carries an expiry date. Phase 2's
  -- resolver returns null once now() >= expires_at, so Avalara sees a fully-taxable transaction
  -- from that instant on (never an expired-zero, never a silent noop).
  expires_at timestamptz,
  -- Free-text prose recorded alongside the certificate — the veteran's DAV number, an internal
  -- note about which state office issued the reseller permit, etc. Not agent-facing.
  notes text,
  -- The workspace member who recorded this certificate (Phase 3 stamps this from the approving
  -- user's UUID on the founder-approved action). Nullable because an initial data-import row
  -- may not have a workspace member behind it.
  recorded_by uuid REFERENCES public.workspace_members(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the SDK's revoke path when a superseding certificate is recorded (or the certificate
  -- is voided by the state). Retained for audit; the resolver treats revoked_at IS NOT NULL as
  -- non-live.
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.workspace_members(id),
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_tax_exemptions_region_two_letter
    CHECK (jurisdiction_region ~ '^[A-Z]{2}$'),
  CONSTRAINT customer_tax_exemptions_exemption_no_nonempty
    CHECK (length(btrim(exemption_no)) > 0),
  CONSTRAINT customer_tax_exemptions_entity_use_code_nonempty
    CHECK (length(btrim(entity_use_code)) > 0)
);

-- Read-path: "the live certificate(s) for this customer" — Phase 2's resolver plucks LIVE rows
-- (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) per customer, then narrows
-- to the ship-to region.
CREATE INDEX IF NOT EXISTS customer_tax_exemptions_workspace_customer_recorded_at_idx
  ON public.customer_tax_exemptions (workspace_id, customer_id, recorded_at DESC);

-- One-live-certificate-per-region invariant. A superseding certificate for the same region MUST
-- revoke the prior one first — same "confirming predicate at the action point" pattern the
-- ticket_directions partial unique enforces (learning #11).
CREATE UNIQUE INDEX IF NOT EXISTS customer_tax_exemptions_customer_region_live_uidx
  ON public.customer_tax_exemptions (customer_id, jurisdiction_region)
  WHERE revoked_at IS NULL;

-- RLS: service-role only. Every read/write goes through src/lib/customer-tax-exemptions.ts (the
-- SDK chokepoint enforced by scripts/_check-customer-tax-exemptions-sdk-compliance.ts). Per
-- CLAUDE.md § Raw `.from(...)` with no SDK → STOP.
ALTER TABLE public.customer_tax_exemptions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.customer_tax_exemptions IS
  'Per-customer sales-tax exemption records. One row per (customer, certificate). Phase 2 passes the LIVE row (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) to Avalara as exemptionNo + entityUseCode so an exempt buyer is not charged tax at the source rather than refunded after the fact. Written exclusively through src/lib/customer-tax-exemptions.ts.';
COMMENT ON COLUMN public.customer_tax_exemptions.exemption_no IS
  'The certificate/permit reference the state issued the buyer (Avalara exemptionNo).';
COMMENT ON COLUMN public.customer_tax_exemptions.entity_use_code IS
  'Avalara entityUseCode — the stable reason code for WHY the buyer is exempt. MUST match Avalara''s definitions endpoint; an unrecognized code is silently downgraded to fully taxable with a 200 OK.';
COMMENT ON COLUMN public.customer_tax_exemptions.jurisdiction_region IS
  'Two-letter region (state / province) the certificate covers. Uppercased. Phase 2''s resolver keys off this + the ship-to region so an OK certificate does not zero a TX shipment.';
COMMENT ON COLUMN public.customer_tax_exemptions.expires_at IS
  'Optional expiry. Phase 2''s resolver returns null once now() >= expires_at, so an expired certificate does NOT zero tax.';
COMMENT ON COLUMN public.customer_tax_exemptions.revoked_at IS
  'Set by the SDK revoke path when a superseding certificate is recorded or the certificate is voided. Retained for audit; a non-null revoked_at makes the row non-live.';
