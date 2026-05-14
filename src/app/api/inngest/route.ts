import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { syncCustomers, syncOrders } from "@/lib/inngest/sync-shopify";
// CSAT disabled — not currently in use, will be reimplemented differently
// import { ticketCsat } from "@/lib/inngest/ticket-csat";
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
import { ticketAnalysisCron } from "@/lib/inngest/ticket-analysis-cron";
import { dailyAnalysisReportCron } from "@/lib/inngest/daily-analysis-report-cron";
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
  dunningPaydayRetryCron,
} from "@/lib/inngest/dunning";
import { portalAutoResume, portalAutoResumeCron } from "@/lib/inngest/portal-auto-resume";
import { amazonSyncOrders, amazonSyncAsins, amazonDailySyncCron } from "@/lib/inngest/amazon-sync";
import { monthlyRevenueSnapshot } from "@/lib/inngest/monthly-revenue-snapshot";
import { metaSyncSpend, metaDailySyncCron } from "@/lib/inngest/meta-sync";
import { todaySyncCron } from "@/lib/inngest/today-sync";
import { ticketAutoArchive } from "@/lib/inngest/auto-archive";
import { tagCancelRelevanceBulk, tagCancelRelevanceCron } from "@/lib/inngest/review-tagging";
import { amplifierWebhookProcess } from "@/lib/inngest/amplifier-webhooks";
import { returnsProcessDelivery, returnsIssueRefund } from "@/lib/inngest/returns";
import { macroAuditFunction } from "@/lib/inngest/macro-audit";
import { deliveryNightlyAudit } from "@/lib/inngest/delivery-audit";
import { deliverPendingSends } from "@/lib/inngest/deliver-pending-send";
import { crisisDailyCampaign, crisisAdvanceTier } from "@/lib/inngest/crisis-campaign";
import { syncInventory } from "@/lib/inngest/sync-inventory";
import {
  researchIngredients,
  analyzeReviews,
  generateContent,
  researchBenefitGap,
} from "@/lib/inngest/product-intelligence";
import { seoKeywordResearch } from "@/lib/inngest/seo-keyword-research";
import { dailyOrderSnapshot } from "@/lib/inngest/daily-order-snapshot";
import {
  enrichBatch as demographicsEnrichBatch,
  enrichSingle as demographicsEnrichSingle,
  demographicsSnapshotBuilder,
} from "@/lib/inngest/customer-demographics";
import { orderAddressFallback } from "@/lib/inngest/order-address-fallback";
import { resellerDiscoveryWeeklyCron, resellerDiscoveryManual } from "@/lib/inngest/reseller-discovery";
import { textCampaignScheduled, textCampaignSendTick } from "@/lib/inngest/marketing-text";
import { marketingCouponAutoDisable } from "@/lib/inngest/marketing-coupon-cron";
import { klaviyoSmsImport } from "@/lib/inngest/klaviyo-sms-import";
import { klaviyoEventsImport } from "@/lib/inngest/klaviyo-events-import";
import { klaviyoAttributionCompute } from "@/lib/inngest/klaviyo-attribution-compute";

export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    syncCustomers,
    syncOrders,
    // ticketCsat, // disabled
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
    ticketAnalysisCron,
    dailyAnalysisReportCron,
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
    dunningPaydayRetryCron,
    portalAutoResume,
    portalAutoResumeCron,
    amazonSyncOrders,
    amazonSyncAsins,
    amazonDailySyncCron,
    monthlyRevenueSnapshot,
    metaSyncSpend,
    metaDailySyncCron,
    todaySyncCron,
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
    syncInventory,
    researchIngredients,
    analyzeReviews,
    generateContent,
    researchBenefitGap,
    seoKeywordResearch,
    dailyOrderSnapshot,
    demographicsEnrichBatch,
    demographicsEnrichSingle,
    demographicsSnapshotBuilder,
    orderAddressFallback,
    resellerDiscoveryWeeklyCron,
    resellerDiscoveryManual,
    textCampaignScheduled,
    textCampaignSendTick,
    marketingCouponAutoDisable,
    klaviyoSmsImport,
    klaviyoEventsImport,
    klaviyoAttributionCompute,
  ],
});
