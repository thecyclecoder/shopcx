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
import { kbEmbedDocument } from "@/lib/inngest/kb-embed";
import { unifiedTicketHandler } from "@/lib/inngest/unified-ticket-handler";
import { journeySessionCompleted, journeySessionAbandoned } from "@/lib/inngest/journey-outcomes";
import { scrapeHelpCenter } from "@/lib/inngest/scrape-help-center";
import { aiNightlyAnalysis } from "@/lib/inngest/ai-nightly-analysis";
import {
  fraudNightlyScan,
  fraudGenerateSummary,
  fraudCheckOrder,
  fraudCheckCustomer,
  fraudRerunRule,
} from "@/lib/inngest/fraud-detection";
import {
  chargebackReceived,
  chargebackWon,
  chargebackLost,
  chargebackEvidenceReminder,
} from "@/lib/inngest/chargeback-processing";
import { ticketUnsnooze } from "@/lib/inngest/ticket-snooze";
import { syncKlaviyoReviews } from "@/lib/inngest/sync-reviews";
import {
  dunningPaymentFailed,
  dunningNewCardRecovery,
  dunningBillingSuccess,
} from "@/lib/inngest/dunning";
import { portalAutoResume } from "@/lib/inngest/portal-auto-resume";
import { ticketAutoArchive } from "@/lib/inngest/auto-archive";
import { tagCancelRelevanceBulk, tagCancelRelevanceCron } from "@/lib/inngest/review-tagging";
import { amplifierWebhookProcess } from "@/lib/inngest/amplifier-webhooks";
import { returnsProcessDelivery, returnsIssueRefund } from "@/lib/inngest/returns";
import { macroAuditFunction } from "@/lib/inngest/macro-audit";
import { deliveryNightlyAudit } from "@/lib/inngest/delivery-audit";
import { deliverPendingSends } from "@/lib/inngest/deliver-pending-send";
import { crisisDailyCampaign, crisisAdvanceTier } from "@/lib/inngest/crisis-campaign";

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
    kbEmbedDocument,
    journeySessionCompleted,
    journeySessionAbandoned,
    scrapeHelpCenter,
    aiNightlyAnalysis,
    fraudNightlyScan,
    fraudGenerateSummary,
    fraudCheckOrder,
    fraudCheckCustomer,
    fraudRerunRule,
    chargebackReceived,
    chargebackWon,
    chargebackLost,
    chargebackEvidenceReminder,
    ticketUnsnooze,
    syncKlaviyoReviews,
    dunningPaymentFailed,
    dunningNewCardRecovery,
    dunningBillingSuccess,
    portalAutoResume,
    ticketAutoArchive,
    tagCancelRelevanceBulk,
    tagCancelRelevanceCron,
    amplifierWebhookProcess,
    unifiedTicketHandler,
    returnsProcessDelivery,
    returnsIssueRefund,
    macroAuditFunction,
    deliveryNightlyAudit,
    deliverPendingSends,
    crisisDailyCampaign,
    crisisAdvanceTier,
  ],
});
