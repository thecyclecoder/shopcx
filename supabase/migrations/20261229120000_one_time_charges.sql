-- one_time_charges — a single charge against a customer's vaulted SHOPIFY payment method,
-- deliberately kept OUT of public.subscriptions.
--
-- WHY A SEPARATE TABLE, not a `kind` column on subscriptions.
--
-- `subscriptions` is read by analytics (active counts, MRR, churn, recurring-order rate), the
-- customer portal, the cancel flow, dunning, and the Appstle→internal migration sweeps. A
-- one-time charge sitting there is excluded from each of those only by a predicate every reader
-- has to remember. That exact shape has already failed in this codebase: `is_internal = false`
-- meant "Appstle" while there were two engines and silently widened to include ShopCX the moment
-- there were three — `migrateCustomerAppstleSubsToInternal` then picked it up on PORTAL PAGE LOAD
-- and would have cancelled the live contract and flipped the row to internal with zero items.
-- A separate table cannot silently widen. The exclusion is structural, not remembered.
--
-- WHY THERE IS NO CYCLE-CHARGE CLAIM ROW.
--
-- `subscription_cycle_charges` exists because a RECURRING sub has many cycles and needs
-- per-(subscription, cycle) idempotency. A one-time charge has exactly one charge, so per-cycle
-- keying is meaningless — THIS ROW IS THE CLAIM. `status` moves pending → charging under a
-- compare-and-set (`UPDATE ... WHERE status='pending'` returning rows), which is atomic in
-- Postgres and is the same pattern ship-time backfills use. Shopify's own `idempotencyKey` on
-- `subscriptionBillingAttemptCreate` is the second guard, exactly as it is for renewals.
-- Widening the subscription ledger instead would have put a nullable FK and a new CHECK on a
-- table guarding ~28.5k live subscriptions, for no gain.
--
-- LIFECYCLE
--   pending    — created, waiting for `charge_at`. The only state the cron will pick up.
--   charging   — claimed by a run. A crash leaves it here; `charging_since` makes that visible
--                and reclaimable rather than silently stuck forever.
--   charged    — Shopify accepted and created the order. Terminal.
--   failed     — declined, or the contract could not be built. Terminal; NOT handed to dunning
--                (a one-time charge is not a subscription at risk — rotating the customer's card
--                and emailing them about a subscription they do not have would be wrong).
--   cancelled  — pulled before it ran. Terminal.
--
-- The throwaway Shopify contract is CANCELLED as soon as the charge settles. That, not
-- `billingPolicy.maxCycles`, is what makes this genuinely one-time: maxCycles is NOT enforced —
-- verified live on contract 36017143981, which was created with minCycles/maxCycles = 1 and still
-- had 8 addressable billing cycles, identical to an uncapped contract. A cancelled contract can
-- never be billed again by anything, including a future orphan-adoption sweep.
--
-- All writes go through createAdminClient() via src/lib/commerce/one-time-charge.ts.
-- RLS enabled + no policies = deny-all outside the service role. Per CLAUDE.md.

CREATE TABLE IF NOT EXISTS public.one_time_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,

  -- Shopify identities. The contract is created lazily at charge time and cancelled straight
  -- after, so it is NULL before the run and holds a dead contract id after it.
  shopify_customer_id text,
  shopify_contract_id text,
  payment_method_id   text,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'charging', 'charged', 'failed', 'cancelled')),

  -- What to charge. `items` mirrors the shape subscriptions.items uses: internal variant UUIDs,
  -- never shopify_variant_id (CLAUDE.md § internal joins use UUIDs).
  items         jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_cents  integer,
  currency      text NOT NULL DEFAULT 'USD',

  -- Scheduling. `charge_at` in the past means "as soon as the cron next runs".
  charge_at timestamptz NOT NULL DEFAULT now(),

  -- Provenance: who asked for this and why. A charge nobody can explain is a chargeback.
  reason     text,
  created_by text,

  -- Outcome.
  order_id           uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  shopify_order_name text,
  billing_attempt_id text,
  -- Which rail actually charged. Braintree is PREFERRED and tried first: it keeps the customer on
  -- internal rails and needs no throwaway contract. 'shopify' means we could not reach them any
  -- other way (a Shop Pay agreement or a Shopify-vaulted card, i.e. no Braintree token).
  rail               text CHECK (rail IN ('braintree', 'shopify')),
  error              text,
  attempts           integer NOT NULL DEFAULT 0,

  charging_since timestamptz,
  charged_at     timestamptz,
  failed_at      timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The cron's only query: due + pending, oldest first.
CREATE INDEX IF NOT EXISTS one_time_charges_due_idx
  ON public.one_time_charges (workspace_id, status, charge_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS one_time_charges_customer_idx
  ON public.one_time_charges (workspace_id, customer_id, created_at DESC);

-- Find the row behind a contract id when a webhook or an audit only has that.
CREATE INDEX IF NOT EXISTS one_time_charges_contract_idx
  ON public.one_time_charges (shopify_contract_id)
  WHERE shopify_contract_id IS NOT NULL;

ALTER TABLE public.one_time_charges ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.one_time_charges IS
  'Single charges against a vaulted Shopify payment method. Deliberately NOT in public.subscriptions so subscription analytics, the portal, dunning and the migration sweeps exclude them structurally rather than by a remembered predicate. The row IS the idempotency claim (status compare-and-set).';
COMMENT ON COLUMN public.one_time_charges.status IS
  'pending → charging → charged|failed. Claimed by UPDATE ... WHERE status=''pending'' returning rows; a zero-row update means another run won the claim.';
COMMENT ON COLUMN public.one_time_charges.shopify_contract_id IS
  'The throwaway subscription contract used to reach the vaulted payment method. CANCELLED as soon as the charge settles — billingPolicy.maxCycles is NOT enforced by Shopify (verified on 36017143981), so cancellation is the real guarantee this bills only once.';


-- ─── orders.order_type gains 'one_time' ────────────────────────────────────────────────────────
--
-- ⚠️ Without this the whole "stays out of subscription stats" premise fails, and fails SILENTLY.
--
-- A one-time charge is billed through `subscriptionBillingAttemptCreate`, so Shopify stamps the
-- resulting order `source_name = 'subscription_contract_checkout_one'` — byte-identical to a real
-- ShopCX renewal. This workspace's `order_source_mapping` maps that source to **'recurring'**, so
-- the order is counted as a renewal on the dashboard, in recurring-order analytics, and by the
-- rules engine (which exposes `order.order_type` as a condition field).
--
-- `orders.subscription_id` is already NULL for these, which covers every reader keyed on the join
-- — but nothing keyed on `order_type`. Both have to be right.
--
-- Measured on the live verification charge (order SC138755, 2026-09-15): the UPDATE to
-- 'one_time' was REJECTED with 23514 against `orders_order_type_check`, whose allowed set was
-- ('checkout','recurring','replacement','unknown'). A PostgREST update that violates a check
-- returns an error, but a caller that does not READ the error sees a silent no-op — so the order
-- would simply have stayed misclassified.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
  CHECK (order_type = ANY (ARRAY['checkout'::text, 'recurring'::text, 'replacement'::text, 'unknown'::text, 'one_time'::text]));

COMMENT ON COLUMN public.orders.order_type IS
  'checkout | recurring | replacement | unknown | one_time. `one_time` is a single charge from public.one_time_charges — billed via a subscription contract, so its source_name is indistinguishable from a renewal and it MUST be reclassified or it inflates recurring-order stats.';
