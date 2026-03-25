import { createAdminClient } from "@/lib/supabase/admin";

export async function logCustomerEvent({
  workspaceId,
  customerId,
  eventType,
  source,
  summary,
  properties,
}: {
  workspaceId: string;
  customerId: string | null;
  eventType: string;
  source: string;
  summary?: string;
  properties?: Record<string, unknown>;
}) {
  const admin = createAdminClient();
  await admin.from("customer_events").insert({
    workspace_id: workspaceId,
    customer_id: customerId,
    event_type: eventType,
    source,
    summary: summary || null,
    properties: properties || {},
  });
}
