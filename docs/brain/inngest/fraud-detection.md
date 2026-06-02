# inngest/fraud-detection

Per-order + per-customer + nightly fraud scans. Evaluates `fraud_rules`, writes `fraud_cases`, tags Shopify orders `suspicious` for hold.

**File:** `src/lib/inngest/fraud-detection.ts`

## Functions

### `fraud-nightly-scan`
- **Trigger:** cron `0 3 * * *`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspaceId" }]`


### `fraud-generate-summary`
- **Trigger:** event `fraud/case.created`
- **Retries:** 2


### `fraud-check-order`
- **Trigger:** event `fraud/order.check`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspaceId" }]`


### `fraud-check-customer`
- **Trigger:** event `fraud/customer.check`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspaceId" }]`


### `fraud-rerun-rule`
- **Trigger:** event `fraud/rule.updated`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspaceId" }]`


## Downstream events sent

- `chargeback/received`

## Tables written

- [[../tables/chargeback_events]]
- [[../tables/customers]]
- [[../tables/dashboard_notifications]]
- [[../tables/fraud_cases]]

## Tables read (not written)

- [[../tables/orders]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
