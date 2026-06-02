# Recipes

How-to pages for common operational tasks. Each page is structured the same way:

- **Helper to call** + file path
- **Params** with types
- **Minimal example** of the call
- **Gotchas** discovered from reading the code

These supplement the [[../libraries]] reference. Libraries describe what a file exposes; recipes describe how to do a thing.

## Subscriptions

- [[change-line-item-price]] — `subUpdateLineItemPrice` (note the 0.75 SubSave multiplier)
- [[swap-variant]] — `subSwapVariant`
- [[change-quantity]] — `subChangeQuantity`
- [[pause-sub]] — `appstleSubscriptionAction("pause")`
- [[resume-sub]] — `appstleSubscriptionAction("resume")`
- [[cancel-sub-via-journey]] — `launchJourneyForTicket("cancel_subscription")`
- [[bill-now]] — `appstleAttemptBilling` or internal-sub equivalent
- [[change-next-date]] — `appstleUpdateNextBillingDate`
- [[apply-coupon]] — `applyDiscountWithReplace`
- [[apply-loyalty-coupon]] — loyalty redeem → coupon → apply-to-sub flow

## Orders + returns

- [[issue-replacement]] — `createReplacementOrder`
- [[create-return]] — `createFullReturn`
- [[issue-refund]] — `partialRefundByAmount`
- [[partial-refund]] — same as issue-refund but customer-initiated path

## Loyalty

- [[redeem-loyalty]] — generate Shopify discount code via `spendPoints` + `loyalty-redeem` handler
- [[apply-loyalty-coupon]] — apply loyalty coupon to a subscription

## Tickets + comms

- [[escalate-ticket]] — `handleEscalation`
- [[send-email-reply]] — `sendTicketReply`
- [[send-chat-reply]] — insert outbound `ticket_messages` row with `pending_send_at`

## Social

- [[ban-meta-user]] — `banUser`
- [[hide-comment]] — `applyModerationDecision({decision:'hide'})`
- [[link-meta-sender-to-customer]] — upsert `meta_sender_customer_links`

## Infra

- [[fire-an-inngest-event]] — `inngest.send({name, data})`
- [[write-a-migration-apply-script]] — `scripts/apply-*.ts` pattern using `pg` client

## Related

[[../README]] · [[../libraries]] · [[../lifecycles/return-pipeline]] · [[../lifecycles/cancel-flow]] · [[../lifecycles/dunning]]
