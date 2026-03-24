import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { syncShopify } from "@/lib/inngest/sync-shopify";
import { ticketCsat } from "@/lib/inngest/ticket-csat";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [syncShopify, ticketCsat],
});
