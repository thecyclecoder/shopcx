import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { syncCustomers, syncOrders } from "@/lib/inngest/sync-shopify";
import { ticketCsat } from "@/lib/inngest/ticket-csat";
import {
  importFileUpload,
  importFileSplit,
  importChunkProcess,
  importChunksComplete,
  importFinalizeBatch,
  importJobComplete,
} from "@/lib/inngest/import-subscriptions";
import { workflowDelayed, positiveCloseDelayed } from "@/lib/inngest/workflow-delayed";
import { kbEmbedDocument } from "@/lib/inngest/kb-embed";
import { aiDraftTicket, aiTriggerWorkflow } from "@/lib/inngest/ai-draft";
import { journeySessionCompleted, journeySessionAbandoned } from "@/lib/inngest/journey-outcomes";
import { scrapeHelpCenter } from "@/lib/inngest/scrape-help-center";

export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    syncCustomers,
    syncOrders,
    ticketCsat,
    importFileUpload,
    importFileSplit,
    importChunkProcess,
    importChunksComplete,
    importFinalizeBatch,
    importJobComplete,
    workflowDelayed,
    positiveCloseDelayed,
    kbEmbedDocument,
    aiDraftTicket,
    aiTriggerWorkflow,
    journeySessionCompleted,
    journeySessionAbandoned,
    scrapeHelpCenter,
  ],
});
