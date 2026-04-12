# Email Tracking System

## Overview
Self-hosted open and click tracking for emails. No Resend domain-level tracking needed — we inject our own tracking pixel and redirect links only into emails we want to track (crisis, marketing). Transactional emails (ticket replies, CSAT, dunning) are NOT tracked to avoid spam filter issues.

## How It Works

### Open Tracking
- `injectTrackingPixel(html)` generates a unique tracking token and injects a 1x1 transparent GIF
- The pixel URL: `/api/track/open/{trackingToken}`
- When the email client loads the image, the endpoint logs an `email.opened` event
- Open tracking is unreliable (~40-50% miss rate due to image blocking)

### Click Tracking
- `injectTrackingLinks(html, trackingToken)` rewrites `<a href>` URLs through our redirect
- The redirect URL: `/api/track/click/{trackingToken}?url={originalUrl}`
- When clicked, logs an `email.clicked` event with the original URL, then 302 redirects

### Combined
- `injectFullTracking(html)` does both in one call — returns `{ html, trackingToken }`

### Token Mapping
- Tracking token is generated BEFORE sending (UUID)
- After sending, `mapTrackingToken()` links the token to the Resend email ID
- The `email_events` row stores `metadata.tracked: true` for tracked emails

## Currently Tracked Emails
- Crisis Tier 1 (auto-swap notification)
- Crisis Tier 2 (product swap + coupon)
- Crisis Tier 3 (pause/remove options)
- Crisis test emails

## Adding Tracking to a New Email
```typescript
import { injectFullTracking, mapTrackingToken } from "@/lib/email-tracking";

// 1. Build your email body
const emailBody = `<p>Hi ${name}...</p>`;

// 2. Inject tracking
const { html: trackedBody, trackingToken } = injectFullTracking(emailBody);

// 3. Send with tracked body
const result = await sendTicketReply({ body: trackedBody, ... });

// 4. Map token to Resend ID
if (result.messageId) {
  await mapTrackingToken(trackingToken, result.messageId, workspaceId, email, subject, ticketId, customerId);
}

// 5. Store clean body (without pixel) in ticket_messages for display
await admin.from("ticket_messages").insert({ body: emailBody, ... });
```

## Delivery Dashboard
- `/dashboard/delivery/email` — health score, rates, bounces, complaints
- Open rate only computed from tracked emails (`metadata.tracked: true`)
- Stats: sent, delivered, opened, clicked, bounced, complained
- Configurable date range: 7, 30, 90 days

## Key Files
- `src/lib/email-tracking.ts` — injectTrackingPixel, injectTrackingLinks, injectFullTracking, mapTrackingToken, logEmailSent, processResendEvent
- `src/app/api/track/open/[emailId]/route.ts` — open pixel endpoint (1x1 GIF)
- `src/app/api/track/click/[trackingId]/route.ts` — click redirect endpoint
- `src/app/api/webhooks/resend-events/route.ts` — Resend webhook handler (delivery/bounce events)
- `src/app/api/workspaces/[id]/delivery-stats/route.ts` — delivery health stats API
- `src/app/dashboard/delivery/email/page.tsx` — delivery dashboard UI

## Database
- `email_events` table — universal log for all email types
- `ticket_messages.resend_email_id` — bare Resend UUID for matching
- `ticket_messages.email_status` — last known status (sent/delivered/opened/clicked/bounced)
