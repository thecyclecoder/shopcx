# ShopCX Roadmap

## In Progress

### Crisis Resolution ("Resolve Crisis" button)
When Mixed Berry is back in stock, the resolve button needs to:
1. **Swap-back subs** (`auto_readd: true`, no pause/remove) — swap from Strawberry Lemonade/Peach Mango back to Mixed Berry
2. **Resume + swap-back paused subs** (`paused_at` + `auto_resume: true`) — resume the sub AND swap back to Mixed Berry
3. **Re-add removed items** (`removed_item_at` + `auto_readd: true`) — add Mixed Berry back to the sub
4. **Grandfathered pricing** — preserve base price on swap-back (same logic as auto-swap)
5. **Email each customer** — "Great news! Mixed Berry is back in stock. Your subscription has been updated."
6. **Customers who swapped to Peach Mango** — offer choice: "Want to switch back to Mixed Berry?" (don't force)
7. **Skip `accepted_default_swap`** — these customers chose to keep Strawberry Lemonade, don't swap them back
8. **Progress tracking** — show real-time progress on the crisis detail page (X resumed, Y swapped back, Z re-added)
9. **Set crisis status to `resolved`**

### Fraud Detail Page Enhancements
- Full order card (line items, addresses, payment, tax, coupons)
- Order number shows SC format with Shopify link
- AI analysis runs once + cache (done), re-analyze button (done)
- Confirmed Fraud wizard (done)

### Portal Fixes Round 2
See `PORTAL-FIXES-2.md` for remaining items

### Ticket Merge
See `TICKET-MERGE-SPEC.md` — Sonnet auto-merge is live, bulk merge updated

### Playbook Improvements
- Positive close detector: don't trigger on questions or crisis "I'll wait" responses
- 529 retry + force response on max tool rounds (done)
- Timeline cleanup (done)
- Mixed policy orders — 30-day guarantee + renewal denial (done)

## Upcoming

### SMS Channel
- Twilio SMS inbound/outbound
- AI agent responds via SMS
- SMS marketing consent + opt-in/out
- SMS workflows (order tracking, cancel, etc.)
- Test with existing customers

### Social DMs (Meta)
- Instagram DM inbound/outbound
- Facebook Messenger inbound/outbound
- AI agent responds on social DMs
- Channel-specific personality (casual, emoji-friendly)

### Social Comments
- Instagram comment monitoring
- Facebook comment monitoring
- Auto-reply to common questions
- Escalate negative comments
- Never send journeys on social comments

### Email Marketing
- Campaign builder (drag-and-drop or template)
- Segmentation (by retention score, LTV, subscription status, tags)
- A/B testing
- Scheduling + send windows
- Deliverability monitoring (bounce/complaint rates)
- Unsubscribe management
- Integration with existing email tracking (open/click)

### SMS Marketing
- Campaign builder for SMS
- Compliance (TCPA, opt-in verification)
- Segmentation
- Link tracking
- Quiet hours enforcement

### Organic Social Posting
- Instagram post scheduling
- Facebook post scheduling
- Content calendar
- AI-generated captions
- Image/video upload
- Engagement metrics

## Completed Recently
- AI fraud detection (Haiku screen on all web orders)
- Confirmed fraud wizard (cancel subs, refund orders, ban customer)
- Portal action overlay (bouncing superfoods animation)
- Flavor change vs product swap separation
- Grandfathered pricing preservation on portal swaps
- Crisis auto-swap button (manual trigger, replaces cron)
- Portal crisis banners (swap-back, paused, removed)
- Ticket auto-merge (Sonnet detects related tickets)
- Chat→email threading
- Playbook active check with Haiku drift detection
- Billing address + payment details from Shopify
- Product ratings from Shopify metafields
- Subscription variant titles backfill
- Portal error logging + analytics dashboard
