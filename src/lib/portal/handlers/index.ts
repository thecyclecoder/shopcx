// Portal route handlers — ported from subscriptions-portal with ShopCX upgrades:
// - DB-first lookups for subscriptions/detail
// - Event logging for all mutations
// - Cancel → journey instead of hard cancel
// - Reviews from product_reviews table (not Klaviyo direct)
// - Dunning awareness on subscription responses
// - Internal ticket notes for agent visibility

export { bootstrap } from "./bootstrap";
export { home } from "./home";
export { subscriptions } from "./subscriptions";
export { subscriptionDetail } from "./subscription-detail";
export { pause } from "./pause";
export { resume } from "./resume";
export { cancel } from "./cancel";
export { reactivate } from "./reactivate";
export { address } from "./address";
export { replaceVariants } from "./replace-variants";
export { coupon } from "./coupon";
export { frequency } from "./frequency";
export { featuredReviews } from "./reviews";
export { cancelJourney } from "./cancel-journey";
export { dunningStatus } from "./dunning-status";
export { changeDate } from "./change-date";
export { orderNow } from "./order-now";
export { submitBanRequest } from "./ban-request";
export { loyaltyBalance } from "./loyalty-balance";
export { loyaltyRedeem } from "./loyalty-redeem";
export { loyaltyApplyToSubscription } from "./loyalty-apply-subscription";
export { linkAccounts } from "./link-accounts";

import type { RouteHandler } from "@/lib/portal/types";
import { bootstrap } from "./bootstrap";
import { home } from "./home";
import { subscriptions } from "./subscriptions";
import { subscriptionDetail } from "./subscription-detail";
import { pause } from "./pause";
import { resume } from "./resume";
import { cancel } from "./cancel";
import { reactivate } from "./reactivate";
import { address } from "./address";
import { replaceVariants } from "./replace-variants";
import { coupon } from "./coupon";
import { frequency } from "./frequency";
import { featuredReviews } from "./reviews";
import { cancelJourney } from "./cancel-journey";
import { dunningStatus } from "./dunning-status";
import { changeDate } from "./change-date";
import { orderNow } from "./order-now";
import { submitBanRequest } from "./ban-request";
import { loyaltyBalance } from "./loyalty-balance";
import { loyaltyRedeem } from "./loyalty-redeem";
import { loyaltyApplyToSubscription } from "./loyalty-apply-subscription";
import { linkAccounts } from "./link-accounts";

export const routeMap: Record<string, RouteHandler> = {
  bootstrap,
  home,
  subscriptions,
  subscriptiondetail: subscriptionDetail,
  subscriptionDetail,
  subscription_detail: subscriptionDetail,
  pause,
  resume,
  cancel,
  reactivate,
  address,
  replacevariants: replaceVariants,
  replaceVariants,
  replace_variants: replaceVariants,
  coupon,
  frequency,
  featuredReviews,
  reviews: featuredReviews,
  canceljourney: cancelJourney,
  cancelJourney,
  cancel_journey: cancelJourney,
  dunningstatus: dunningStatus,
  dunningStatus,
  dunning_status: dunningStatus,
  changedate: changeDate,
  changeDate,
  change_date: changeDate,
  ordernow: orderNow,
  orderNow,
  order_now: orderNow,
  submitbanrequest: submitBanRequest,
  submitBanRequest,
  submit_ban_request: submitBanRequest,
  loyaltybalance: loyaltyBalance,
  loyaltyBalance,
  loyalty_balance: loyaltyBalance,
  loyaltyredeem: loyaltyRedeem,
  loyaltyRedeem,
  loyalty_redeem: loyaltyRedeem,
  loyaltyapplytosubscription: loyaltyApplyToSubscription,
  loyaltyApplyToSubscription,
  loyalty_apply_to_subscription: loyaltyApplyToSubscription,
  linkaccounts: linkAccounts,
  linkAccounts,
  link_accounts: linkAccounts,
};
