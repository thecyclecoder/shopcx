import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { syncShopify } from "@/lib/inngest/sync-shopify";
import { ticketCsat } from "@/lib/inngest/ticket-csat";

// Max duration for Vercel serverless function
export const maxDuration = 300; // 5 minutes (requires Pro plan)

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [syncShopify, ticketCsat],
});
