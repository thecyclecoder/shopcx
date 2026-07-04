/**
 * The single in-code list of every Inngest function this app serves — the exact array
 * passed to `serve()` in src/app/api/inngest/route.ts. Extracted into a plain module
 * (not the route) so the Control Tower self-audit can enumerate it at runtime
 * (control-tower-complete-coverage spec, Phase 2): the serve list is the authoritative
 * "what's in code" set the self-audit diffs against the registry + against what Inngest
 * Cloud has actually registered. Add a new function HERE (and the route picks it up).
 *
 * See docs/brain/libraries/control-tower-self-audit.md.
 */
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
import { directorRecapCron } from "@/lib/inngest/director-recap-cron";
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
import { metaSyncPerformance, metaPerformanceDailyCron, metaAttributionRefresh, metaScorecardsRefresh, metaDecisionEngine, metaIterationRun, metaExecuteRecommendation } from "@/lib/inngest/meta-performance";
import { storefrontExperimentsRefresh, storefrontExperimentsRefreshCron } from "@/lib/inngest/storefront-experiments";
import { storefrontLtvMetricsRefresh } from "@/lib/inngest/storefront-ltv-metrics";
import { storefrontLtvReconcile, storefrontLtvReconcileCron } from "@/lib/inngest/storefront-ltv-reconcile";
import { storefrontLeverDecay, storefrontLeverDecayCron } from "@/lib/inngest/storefront-lever-decay";
import { storefrontOptimizerCron, storefrontOptimizerSchedule } from "@/lib/inngest/storefront-optimizer";
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
import { popupSmsDeliveryFallback } from "@/lib/inngest/popup-sms-delivery-fallback";
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
import { smsCallbackDrain, smsInboundDrain } from "@/lib/inngest/sms-callback-drain";
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
import { triageEscalationsCron } from "@/lib/inngest/triage-escalations";
import { specTestCron } from "@/lib/inngest/spec-test-cron";
import { specReviewCron } from "@/lib/inngest/spec-review-cron";
import { specReviewOnMutate } from "@/lib/inngest/spec-review-on-mutate";
import { portalActionHealer } from "@/lib/inngest/portal-action-healer";
import { slackRoadmapNotify } from "@/lib/inngest/slack-roadmap-notify";
import { brainIndexRefresh } from "@/lib/inngest/brain-index-refresh";
import { creativeFinderDailyCron, creativeFinderManualSweep, creativeFinderVideoProcess } from "@/lib/inngest/creative-finder";
import { competitorScoutDiscover } from "@/lib/inngest/competitor-scout";
import { landingPageScoutAnalyze } from "@/lib/inngest/landing-page-scout";
import { acquisitionResearchCadenceCron, acquisitionResearchCadenceManual } from "@/lib/inngest/acquisition-research-cadence";
import { researchSensorCron } from "@/lib/inngest/research-sensor";
import { controlTowerMonitor } from "@/lib/inngest/control-tower-monitor";
import { specDriftReconcileCron } from "@/lib/inngest/spec-drift-reconcile";
import { fleetSpendGovernorCron } from "@/lib/inngest/fleet-spend-governor";
import { growthAdSpendGovernorCron, growthAdSpendGovernorSweep } from "@/lib/inngest/growth-ad-spend-governor";
import { inngestFailureCapture } from "@/lib/inngest/inngest-failure-capture";
import { supabaseLogPollCron } from "@/lib/inngest/supabase-log-poll";
import { loopHeartbeatsPrune } from "@/lib/inngest/loop-heartbeats-prune";
import { claudeStatusPollCron } from "@/lib/inngest/claude-status-poll-cron";
import { deployGuardianCron } from "@/lib/inngest/deploy-guardian-cron";
import { dailyDigestCron } from "@/lib/inngest/daily-digest-cron";
import { platformDirectorCron } from "@/lib/inngest/platform-director-cron";
import { buildOnEligible } from "@/lib/inngest/build-on-eligible";
import { securityDepWatch } from "@/lib/inngest/security-dep-watch";
import { securityDiffBackstopCron } from "@/lib/inngest/security-diff-backstop-cron";

/** Every function served at /api/inngest. The serve route spreads this verbatim. */
export const registeredInngestFunctions = [
  claudeStatusPollCron,
  deployGuardianCron,
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
  directorRecapCron,
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
  storefrontExperimentsRefresh,
  storefrontExperimentsRefreshCron,
  storefrontLtvMetricsRefresh,
  storefrontLtvReconcileCron,
  storefrontLtvReconcile,
  storefrontLeverDecay,
  storefrontLeverDecayCron,
  storefrontOptimizerCron,
  storefrontOptimizerSchedule,
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
  metaDecisionEngine,
  metaIterationRun,
  metaExecuteRecommendation,
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
  popupSmsDeliveryFallback,
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
  smsCallbackDrain,
  smsInboundDrain,
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
  triageEscalationsCron,
  specTestCron,
  specReviewCron,
  specReviewOnMutate,
  portalActionHealer,
  slackRoadmapNotify,
  brainIndexRefresh,
  creativeFinderDailyCron,
  creativeFinderManualSweep,
  creativeFinderVideoProcess,
  competitorScoutDiscover,
  landingPageScoutAnalyze,
  acquisitionResearchCadenceCron,
  acquisitionResearchCadenceManual,
  researchSensorCron,
  controlTowerMonitor,
  specDriftReconcileCron,
  fleetSpendGovernorCron,
  growthAdSpendGovernorCron,
  growthAdSpendGovernorSweep,
  inngestFailureCapture,
  supabaseLogPollCron,
  loopHeartbeatsPrune,
  dailyDigestCron,
  platformDirectorCron,
  buildOnEligible,
  securityDepWatch,
  securityDiffBackstopCron,
];

/** Our Inngest app id prefix (e.g. "shopcx-"), the form Inngest prepends to function ids across apps. */
export const APP_FUNCTION_ID_PREFIX = `${inngest.id}-`;

/**
 * Every served function's APP-PREFIXED id (e.g. "shopcx-amazon-sync-orders") — exactly the
 * form Inngest reports in the `inngest/function.failed` event's `function_id`. Used by
 * inngest-failure-capture to scope the Control Tower error feed to OUR app and drop
 * sibling-app noise (inngest-capture-scope-own-app spec).
 */
export const servedFunctionIds: ReadonlySet<string> = new Set(
  registeredInngestFunctions.map((fn) => fn.id(inngest.id)),
);

/** The same ids in their BARE (un-prefixed) form (e.g. "amazon-sync-orders") — tolerant fallback. */
export const servedFunctionBareIds: ReadonlySet<string> = new Set(
  registeredInngestFunctions.map((fn) => fn.id()),
);
