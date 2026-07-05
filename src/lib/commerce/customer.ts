/**
 * commerce/customer.ts — Display ops for customers.
 *
 * `getCustomer` hydrates the customer row plus a compact rollup of the
 * [[../../docs/brain/tables/customer_events]] timeline and the
 * [[../../docs/brain/tables/customer_demographics]] enrichment so a surface can
 * render a customer card without a second query.
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  CustomerView,
  CustomerEventsSummaryView,
  CustomerDemographicsView,
} from "./types";

export type { CustomerView } from "./types";

const CUSTOMER_COLUMNS =
  "id, workspace_id, email, first_name, last_name, phone, subscription_status, subscription_tenure_days, total_orders, ltv_cents, first_order_at, last_order_at, tags, addresses, default_address, email_marketing_status, sms_marketing_status, portal_banned, is_internal, created_at";

interface RawCustomerRow {
  id: string;
  workspace_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  subscription_status: string | null;
  subscription_tenure_days: number | null;
  total_orders: number | null;
  ltv_cents: number | null;
  first_order_at: string | null;
  last_order_at: string | null;
  tags: string[] | null;
  addresses: unknown;
  default_address: Record<string, unknown> | null;
  email_marketing_status: string | null;
  sms_marketing_status: string | null;
  portal_banned: boolean | null;
  is_internal: boolean | null;
  created_at: string;
}

async function loadEventsSummary(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  customerId: string,
): Promise<CustomerEventsSummaryView | null> {
  const { count } = await admin
    .from("customer_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId);
  const { data: latest } = await admin
    .from("customer_events")
    .select("event_type, created_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if ((count ?? 0) === 0 && !latest) return null;
  return {
    total_events: count ?? 0,
    last_event_type: (latest?.event_type as string | undefined) ?? null,
    last_event_at: (latest?.created_at as string | undefined) ?? null,
  };
}

async function loadDemographics(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  customerId: string,
): Promise<CustomerDemographicsView | null> {
  const { data } = await admin
    .from("customer_demographics")
    .select(
      "inferred_gender, inferred_age_range, zip_income_bracket, zip_urban_classification",
    )
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!data) return null;
  const row = data as {
    inferred_gender: string | null;
    inferred_age_range: string | null;
    zip_income_bracket: string | null;
    zip_urban_classification: string | null;
  };
  return {
    inferred_gender: row.inferred_gender,
    inferred_age_range: row.inferred_age_range,
    zip_income_bracket: row.zip_income_bracket,
    zip_urban_classification: row.zip_urban_classification,
  };
}

/**
 * Fetch one customer, hydrated with a `customer_events` summary and
 * `customer_demographics` snapshot. Throws if the customer is missing or not
 * in the given workspace.
 */
export async function getCustomer(
  workspaceId: string,
  customerId: string,
): Promise<CustomerView> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new Error(`getCustomer: not found — workspace=${workspaceId} customer=${customerId}`);
  const row = data as RawCustomerRow;

  const [events_summary, demographics] = await Promise.all([
    loadEventsSummary(admin, workspaceId, customerId),
    loadDemographics(admin, workspaceId, customerId),
  ]);

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    email: row.email ?? "",
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    subscription_status: (row.subscription_status ?? "never") as CustomerView["subscription_status"],
    subscription_tenure_days: Number(row.subscription_tenure_days ?? 0),
    total_orders: Number(row.total_orders ?? 0),
    ltv_cents: Number(row.ltv_cents ?? 0),
    first_order_at: row.first_order_at,
    last_order_at: row.last_order_at,
    tags: Array.isArray(row.tags) ? row.tags : [],
    addresses: Array.isArray(row.addresses)
      ? (row.addresses as Array<Record<string, unknown>>)
      : [],
    default_address: row.default_address,
    email_marketing_status: row.email_marketing_status ?? "not_subscribed",
    sms_marketing_status: row.sms_marketing_status ?? "not_subscribed",
    portal_banned: Boolean(row.portal_banned),
    is_internal: Boolean(row.is_internal),
    events_summary,
    demographics,
    created_at: row.created_at,
  };
}
