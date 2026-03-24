import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { syncCustomers, syncOrders } from "@/lib/inngest/sync-shopify";
import { ticketCsat } from "@/lib/inngest/ticket-csat";

export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [syncCustomers, syncOrders, ticketCsat],
});
