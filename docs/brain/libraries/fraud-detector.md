# libraries/fraud-detector

Rule evaluator + case creator. Iterates active [[../tables/fraud_rules]] for the workspace, runs the matcher per rule, creates [[../tables/fraud_cases]] on match.

**File:** `src/lib/fraud-detector.ts`

## Exports

### `runAllFraudRules` — function

```ts
async function runAllFraudRules(workspaceId: string) : Promise<FraudDetectionResult[]>
```

### `checkOrderForFraud` — function

```ts
async function checkOrderForFraud(workspaceId: string, orderId: string, customerId: string | null) : Promise<void>
```

### `checkCustomerForFraud` — function

```ts
async function checkCustomerForFraud(workspaceId: string, customerId: string) : Promise<void>
```

### `orderUuids` — function

```ts
function orderUuids(ids: unknown[]) : string[]
```

Keep only values matching the UUID shape. Used to guard every reader that feeds `fraud_cases.order_ids` back into `.in('id', …)` on [[../tables/orders]] — a legacy Shopify numeric id in that array would otherwise throw Postgres 22P02 (`invalid input syntax for type uuid`) and silently drop the whole batch of fraud orders. Every writer already stores `order.id`; this is the defense-in-depth for stray legacy entries that predate that fix.

## Callers

- `src/app/api/checkout/route.ts`
- `src/lib/inngest/fraud-detection.ts`

## `FREEMAIL_DOMAINS` — the public-provider exclusion set

Several signals (`email_domain_velocity`, `surname_velocity`, the repeat-offender `same_email_domain` match) only fire on a **custom** domain — one a ring plausibly controls. Public/shared domains are excluded via `FREEMAIL_DOMAINS`, a `Set` built at module load from **`src/lib/engine/fraud/freemail-domains.json`** (the vendored [`free-email-domains`](https://github.com/Kikobeats/free-email-domains) list, ~12.3k freemail/ISP/disposable domains) unioned with a small inline supplement. The set, `emailDomain`, and the velocity evaluators now live in the shared engine (`src/lib/engine/fraud/`, see [[engine]]) and are imported back here.

- **Why vendored, not hand-seeded:** the original inline list of ~26 domains missed legacy providers and produced a false-positive ring on 4 unrelated `@netscape.net` customers (case `3e1e138c`, 2026-06-18). The full list includes `netscape.net` and the long tail of regional ISPs / international providers.
- **Disposable domains (mailinator, guerrillamail, …) are intentionally in the set.** This is an *exclusion* list — strangers share these too, so velocity on them is noisy. If we ever want to *flag* disposable mail, that's a separate signal, not a removal from here.
- **Refreshing:** re-download `domains.json` from the upstream repo, rebuild the JSON (sorted, deduped, lowercased), add any gaps to the inline supplement (`netscape.com` is one). No runtime dependency — the list is a checked-in JSON import (`resolveJsonModule`).

## Velocity signals — `checkVelocitySignals`

Real-time, rule-independent signals run per paid web order (subscription renewals are skipped — the card never rotates). Each fires an OPEN `fraud_cases` row (Dylan confirms in the UI; that path cancels subs + refunds to head off chargebacks) and tags the ring's orders `suspicious`. Three keys: `bin_velocity`, `email_domain_velocity`, `surname_velocity`, all opened through the shared `openCase(ruleType, velocityKey, …)` closure.

### BIN velocity — a real cross-account link, never a shared BIN alone

A card **BIN only identifies the issuing bank**. Popular consumer banks (e.g. Visa `414740`, a common Chase range) issue to millions, so thousands of unrelated legit customers share one BIN with fully diverse names/addresses/cards. **A shared BIN is NEVER enough to flag anyone.** (Ground truth: the Sep-2026 `bin:414740` false-positive case — an account-blind "one card reused 4–5 times" corroborator was a single fraudster reusing HER OWN card on HER OWN account, yet it swept in 8 unrelated subscribers, auto-cancelled ~17 subscriptions, refunded $1,017, and banned them.)

The concentration logic is factored into the **pure, unit-tested** `evaluateBinCluster(bin, rows, history)`, which lives in the shared engine (`src/lib/engine/fraud/bin-cluster.ts`, see [[engine]]) and is re-exported from this file (covered by `src/lib/fraud-detector.bin-velocity.test.ts`, registered as `npm run test:fraud-bin-velocity`). A BIN case opens ONLY when the cluster carries a genuine cross-account link or an order-level suspicion signal, and is **scoped to only the linked accounts**:

- **`crossAccountCardReuse`** replaces the old account-blind `maxCardReuse`: for each card key (`card_last4` + `card_exp`) it counts **DISTINCT `customer_id`s**. A card only corroborates when used by **≥2 distinct accounts** — one account reusing its own card never counts.
- Corroborators (any one; each computed across distinct accounts): (a) same card on ≥2 accounts [earns the "stolen-card batch" summary]; (b) same normalized shipping address (`address1`+zip5) on ≥2 accounts; (c) same phone on ≥2 accounts; (d) same browser IP on ≥2 accounts (read from `payment_details.browser_ip` if already captured — no new per-order API call); (e) ≤2 distinct cardholder surnames across **≥3** accounts.
- **Order-level independent suspicion** qualifies that ONE order + its account only on an **AVS/CVV failure** (`avs_result_code`/`cvv_result_code` — now persisted from the GraphQL `transactions` query into `payment_details`) or a **Shopify risk recommendation of `cancel`/`investigate`**. A **card-name vs billing-name mismatch alone NEVER flags an order** — a different first name on the card is a nickname (Pamela M Boswell vs Pam Boswell) or a family member's card (Michael Maurizi vs Tina Maurizi) far more often than fraud (across one month, 25 of 212 one-time orders with a captured card would have been held on this alone). A mismatch is recorded as *supporting evidence* when a real second signal co-occurs (it appears in the `order_level_suspicion` reason text), but it never opens or joins a case by itself. A customer with a genuine cross-account link (a)–(d) is already linked regardless of name. (Founder call, 2026-10-14, correcting the 2026-10-13 BIN fix.)
- **Established-customer exclusion:** a customer with ≥3 prior paid orders, no active chargeback, and the same card as their prior orders is never added on BIN (surname) grounds alone — but a hard cross-account link (a)–(d) keeps them in.
- Evidence JSON records `corroborator`, `corroborators`, `cross_account_card_reuse`, `linked_customer_ids`, `linked_order_ids`, `excluded_established_customer_count`. The boilerplate "stolen-card batch" claim only appears when corroborator (a) fired.

### A dismissed velocity case stays dismissed (Phase 2)

`openCase` takes a `members: VelocityCaseMember[]` list (each `{ customerId, orderId, shopOrderId }`) rather than three parallel arrays, and before opening a case it applies the pure, unit-tested `applyDismissalSuppression(members, dismissedCustomerIds)`:

- It loads the **most recent `dismissed` case** for the same `workspace_id` + `rule_type` + `evidence.velocity_key` within `BIN_DISMISS_SUPPRESS_DAYS` (= the 30-day window) and subtracts those customers from the linked set.
- If **nothing new remains**, no case is opened, no orders are held, nothing is tagged — a dismissal on a key stays dismissed for those same customers. (Before this, `openCase` only excluded `confirmed_fraud`/`dismissed` from the *dedupe* lookup, so the Sep-2026 `bin:414740` case re-opened 6× after Zach dismissed it twice, until one was confirmed and innocent subscribers were cancelled + banned.)
- If **new customers remain**, a case opens for only them, and the reappearing dismissed customers are recorded as `evidence.suppressed_dismissed_customer_ids`.
- This suppression is shared by all three velocity keys (`bin_velocity`, `email_domain_velocity`, `surname_velocity`) because they all route through `openCase`.

## Gotchas

- **Don't re-introduce a hand-maintained domain list.** A short inline `Set` will silently miss providers and flag real customers as a ring. Edit the vendored JSON / supplement instead.
- **`fraud_cases.order_ids` is `orders.id` UUIDs, NOT `shopify_order_id`.** Historically half the writers put `o.shopify_order_id` into `order_ids` while one used `order.id`; the two UUID readers (`.in('id', order_ids)` in the confirmed-fraud similarity batch loop + high-velocity loader) then threw Postgres 22P02 on the Shopify entries and silently dropped whole batches of fraud orders. Every writer now stores `order.id`; readers wrap the array with `orderUuids()` as defense-in-depth. When you tag orders in Shopify (`addOrderTags`), pass the `shopify_order_id` separately — the Shopify tags API needs the numeric id, not the internal UUID.
- **Control Tower coverage (`ai:fraud-detector`).** `checkOrderForFraud` is a public wrapper around `checkOrderForFraudInner` (returns whether a case fired) that emits ONE [[../tables/loop_heartbeats]] beat in a try/finally at the end of every per-order screen ([[../specs/control-tower-agent-coverage]] · [[control-tower]]). `ok:true` on a clean screen whether or not it flagged; `ok:false` only when the screen threw; `produced` carries `{order, flagged}`. The monitor's liveness-when-work-exists alert fires when [[../tables/orders]] were created in the window but 0 successful fraud-screen beats landed.

---

[[../README]] · [[../../CLAUDE]]
