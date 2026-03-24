import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { syncShopify } from "@/lib/inngest/sync-shopify";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [syncShopify],
});
