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

## Callers

- `src/app/api/checkout/route.ts`
- `src/lib/inngest/fraud-detection.ts`

## `FREEMAIL_DOMAINS` — the public-provider exclusion set

Several signals (`email_domain_velocity`, `surname_velocity`, the repeat-offender `same_email_domain` match) only fire on a **custom** domain — one a ring plausibly controls. Public/shared domains are excluded via `FREEMAIL_DOMAINS`, a `Set` built at module load from **`src/lib/freemail-domains.json`** (the vendored [`free-email-domains`](https://github.com/Kikobeats/free-email-domains) list, ~12.3k freemail/ISP/disposable domains) unioned with a small inline supplement.

- **Why vendored, not hand-seeded:** the original inline list of ~26 domains missed legacy providers and produced a false-positive ring on 4 unrelated `@netscape.net` customers (case `3e1e138c`, 2026-06-18). The full list includes `netscape.net` and the long tail of regional ISPs / international providers.
- **Disposable domains (mailinator, guerrillamail, …) are intentionally in the set.** This is an *exclusion* list — strangers share these too, so velocity on them is noisy. If we ever want to *flag* disposable mail, that's a separate signal, not a removal from here.
- **Refreshing:** re-download `domains.json` from the upstream repo, rebuild the JSON (sorted, deduped, lowercased), add any gaps to the inline supplement (`netscape.com` is one). No runtime dependency — the list is a checked-in JSON import (`resolveJsonModule`).

## Gotchas

- **Don't re-introduce a hand-maintained domain list.** A short inline `Set` will silently miss providers and flag real customers as a ring. Edit the vendored JSON / supplement instead.
- **Control Tower coverage (`ai:fraud-detector`).** `checkOrderForFraud` is a public wrapper around `checkOrderForFraudInner` (returns whether a case fired) that emits ONE [[../tables/loop_heartbeats]] beat in a try/finally at the end of every per-order screen ([[../specs/control-tower-agent-coverage]] · [[control-tower]]). `ok:true` on a clean screen whether or not it flagged; `ok:false` only when the screen threw; `produced` carries `{order, flagged}`. The monitor's liveness-when-work-exists alert fires when [[../tables/orders]] were created in the window but 0 successful fraud-screen beats landed.

---

[[../README]] · [[../../CLAUDE]]
