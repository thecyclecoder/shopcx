import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { syncCustomers, syncOrders } from "@/lib/inngest/sync-shopify";
import { ticketCsatCron } from "@/lib/inngest/ticket-csat";
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
import { sonnetPromptAutoReviewCron } from "@/lib/inngest/sonnet-prompt-auto-review";
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
import { metaSyncPerformance, metaPerformanceDailyCron, metaAttributionRefresh, metaScorecardsRefresh } from "@/lib/inngest/meta-performance";
import { todaySyncCron } from "@/lib/inngest/today-sync";
import { ticketAutoArchive } from "@/lib/inngest/auto-archive";
import { tagCancelRelevanceBulk, tagCancelRelevanceCron } from "@/lib/inngest/review-tagging";
import { amplifierWebhookProcess } from "@/lib/inngest/amplifier-webhooks";
import {
  internalSubscriptionRenewalCron,
  internalSubscriptionRenewalAttempt,
} from "@/lib/inngest/internal-subscription-renewals";
import { migrationAuditRetryCron } from "@/lib/inngest/migration-audit-retry";
import { migrationIntegritySweepCron } from "@/lib/inngest/migration-integrity-sweep";
import { metaCapiDispatchCron } from "@/lib/inngest/meta-capi-dispatch";
import { popupCouponFallback } from "@/lib/inngest/popup-coupon-fallback";
import { returnsProcessDelivery, returnsIssueRefund } from "@/lib/inngest/returns";
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
import { dailyOrderSnapshot, dailyOrderSnapshotSelfHeal } from "@/lib/inngest/daily-order-snapshot";
import {
  enrichBatch as demographicsEnrichBatch,
  enrichSingle as demographicsEnrichSingle,
  demographicsSnapshotBuilder,
} from "@/lib/inngest/customer-demographics";
import { orderAddressFallback } from "@/lib/inngest/order-address-fallback";
import { resellerDiscoveryWeeklyCron, resellerDiscoveryManual } from "@/lib/inngest/reseller-discovery";
import { textCampaignScheduled, textCampaignSendTick } from "@/lib/inngest/marketing-text";
import { refreshCustomerSegmentsCron, refreshWorkspaceSegments } from "@/lib/inngest/refresh-customer-segments";
import { smsWavePromote } from "@/lib/inngest/sms-wave-promote";
import { marketingCouponAutoDisable } from "@/lib/inngest/marketing-coupon-cron";
import { abandonedCartReminder } from "@/lib/inngest/abandoned-cart";
import { socialSchedulerPlan, socialPublish } from "@/lib/inngest/social-scheduler";
import { autoBlogGenerate } from "@/lib/inngest/auto-blog";
import { featuredReviewCardsCron } from "@/lib/inngest/featured-review-cards";
import { socialInsightsSync } from "@/lib/inngest/social-insights";
import { socialPromoGraphics } from "@/lib/inngest/social-promo-graphics";
import { klaviyoSmsImport } from "@/lib/inngest/klaviyo-sms-import";
import { klaviyoEventsImport } from "@/lib/inngest/klaviyo-events-import";
import { klaviyoAttributionCompute } from "@/lib/inngest/klaviyo-attribution-compute";
import { klaviyoEngagementBackfill } from "@/lib/inngest/klaviyo-engagement-backfill";
import { klaviyoEngagementSync } from "@/lib/inngest/klaviyo-engagement-sync";
import { socialCommentModerate } from "@/lib/inngest/social-comment-moderate";
import { metaHistoricalCommentsSync } from "@/lib/inngest/meta-historical-comments-sync";
import { ticketResearchRequested, ticketHealRequested } from "@/lib/inngest/ticket-research";
import { adToolFunctions } from "@/lib/inngest/ad-tool";
import { agentTodoExecute } from "@/lib/inngest/agent-todo-execute";
import { portalActionHealer } from "@/lib/inngest/portal-action-healer";
import { foundervipFollowupGate } from "@/lib/inngest/foundervip-followup-gate";
import { slackRoadmapNotify } from "@/lib/inngest/slack-roadmap-notify";
import { brainIndexRefresh } from "@/lib/inngest/brain-index-refresh";
import { creativeFinderDailyCron, creativeFinderManualSweep } from "@/lib/inngest/creative-finder";

// 800s (Fluid Compute max) — single Inngest steps can run a long Sonnet call
// (per-ingredient research, per-chunk review analysis). 300s timed those out
// (FUNCTION_INVOCATION_TIMEOUT) and failed the product-intelligence runs.
export const maxDuration = 800;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ...adToolFunctions,
    syncCustomers,
    syncOrders,
    ticketCsatCron,
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
    sonnetPromptAutoReviewCron,
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
    metaSyncPerformance,
    metaPerformanceDailyCron,
    metaAttributionRefresh,
    metaScorecardsRefresh,
    todaySyncCron,
    ticketAutoArchive,
    tagCancelRelevanceBulk,
    tagCancelRelevanceCron,
    amplifierWebhookProcess,
    internalSubscriptionRenewalCron,
    internalSubscriptionRenewalAttempt,
    migrationAuditRetryCron,
    migrationIntegritySweepCron,
    metaCapiDispatchCron,
    popupCouponFallback,
    unifiedTicketHandler,
    returnsProcessDelivery,
    returnsIssueRefund,
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
    dailyOrderSnapshotSelfHeal,
    demographicsEnrichBatch,
    demographicsEnrichSingle,
    demographicsSnapshotBuilder,
    orderAddressFallback,
    resellerDiscoveryWeeklyCron,
    resellerDiscoveryManual,
    textCampaignScheduled,
    textCampaignSendTick,
    smsWavePromote,
    refreshCustomerSegmentsCron,
    refreshWorkspaceSegments,
    marketingCouponAutoDisable,
    abandonedCartReminder,
    socialSchedulerPlan,
    socialPublish,
    autoBlogGenerate,
    featuredReviewCardsCron,
    socialInsightsSync,
    socialPromoGraphics,
    klaviyoSmsImport,
    klaviyoEventsImport,
    klaviyoAttributionCompute,
    klaviyoEngagementBackfill,
    klaviyoEngagementSync,
    socialCommentModerate,
    metaHistoricalCommentsSync,
    ticketResearchRequested,
    ticketHealRequested,
    agentTodoExecute,
    portalActionHealer,
    foundervipFollowupGate,
    slackRoadmapNotify,
    brainIndexRefresh,
    creativeFinderDailyCron,
    creativeFinderManualSweep,
  ],
});
