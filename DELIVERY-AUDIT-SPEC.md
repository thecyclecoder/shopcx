# Nightly Delivery Audit — EasyPost Cron Spec

## Overview
Nightly Inngest cron that proactively checks delivery status via EasyPost for orders that Shopify hasn't confirmed as delivered. Catches refused shipments, return-to-sender, delivery failures before the customer even contacts us.

## Trigger
- **Schedule:** Nightly at 6:00 AM Central (before business hours)
- **Inngest function:** `delivery/nightly-audit`
- **Concurrency:** 1 (only one audit runs at a time)

## Query
Orders that match ALL of:
- `fulfillment_status = 'FULFILLED'`
- `delivery_status = 'not_delivered'`
- `created_at < now() - 14 days` (configurable per workspace)
- Has at least one fulfillment with a tracking number
- `sync_resolved_at IS NULL` (hasn't already been audited)

## EasyPost Lookup
- One `Tracker.create()` call per order (~$0.02/lookup)
- 200ms delay between calls to avoid rate limits
- Carrier auto-detected if not in fulfillment data

## Actions by Status

### `delivered`
- Update `delivery_status = 'delivered'`, `delivered_at` from event timestamp
- No ticket, no notification

### `return_to_sender` — Refused
- **Cancel linked subscription** via Appstle (reason: "Shipment Refused - Auto Cancel")
- Update subscription status locally to `cancelled`
- Mark order `sync_resolved_note = "Refused at delivery"`
- **No ticket created** — customer chose to refuse
- Dashboard notification for visibility

### `return_to_sender` — Other (wrong address, unclaimed, etc.)
- **Create ticket** for the customer (channel: system, status: open)
- **Assign replacement order playbook** to the ticket
- Tag ticket: `return-to-sender`, `rts:{reason}`
- Internal note with EasyPost details + tracking events
- Dashboard notification

### `failure` / `error`
- Same as return_to_sender other — create ticket + replacement playbook
- Tag: `delivery-failure`

### `in_transit` / `out_for_delivery` / `pre_transit` / `unknown`
- No action — check again tomorrow
- If `in_transit` for 21+ days → create dashboard notification for review

## Cost Estimate
- 2 orders today (edge case, most were bulk-updated)
- Steady state: ~50-100 orders/night at scale = $1-2/night
- Only checks orders once (until resolved or delivered)

## Settings (per workspace)
- `delivery_audit_enabled` (boolean, default false)
- `delivery_audit_lookback_days` (number, default 14)
- `delivery_audit_stale_days` (number, default 21 — when to flag still-in-transit)

## Implementation Plan

### 1. Migration
- Add `delivery_audit_enabled`, `delivery_audit_lookback_days`, `delivery_audit_stale_days` to `workspaces`

### 2. Inngest Function (`src/lib/inngest/delivery-audit.ts`)
```typescript
inngest.createFunction(
  { id: "delivery/nightly-audit", concurrency: { limit: 1 } },
  { cron: "0 11 * * *" }, // 6 AM Central = 11 UTC
  async ({ step }) => {
    // Step 1: Get workspaces with audit enabled
    // Step 2: For each workspace, query eligible orders
    // Step 3: For each order, EasyPost lookup (batched in steps for durability)
    // Step 4: Take action based on status
  }
);
```

### 3. Dashboard Settings
- Add toggle + config to Settings > Integrations > EasyPost card
- Or separate Settings > Delivery Audit section

### 4. Replacement Order Playbook (separate task)
- Confirm shipping address
- Offer to reship or refund
- If reship: create new Shopify order via draft
- If refund: process via Shopify

## Script (for manual runs before cron is live)
```bash
# Dry run
ENCRYPTION_KEY=... npx tsx scripts/easypost-delivery-audit.ts --dry-run

# Live
ENCRYPTION_KEY=... npx tsx scripts/easypost-delivery-audit.ts

# Custom lookback
ENCRYPTION_KEY=... npx tsx scripts/easypost-delivery-audit.ts --days 7
```
