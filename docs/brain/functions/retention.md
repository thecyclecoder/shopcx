# Retention (function)

The permanent owner of **subscriptions and everything that keeps people subscribed** — billing continuity, dunning recovery, the cancel-flow, pause/resume, win-back, and the flows/journeys that reduce churn. One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **Retention director-agent's CEO-mode charter** and the **home that owns every Retention mandate + spec** on the roadmap.

## Scope + owned metrics

- **Owns:** active-subscription base, the subscription billing engine (Appstle → in-house migration), dunning/payment recovery, cancel-flow + remedies, pause/resume/reactivate, win-back, churn-prevention journeys.
- **North-star metrics:** **net subscriber retention** / churn rate, involuntary-churn (dunning) recovery rate, reactivation rate, subscriber LTV.
- **Data we have:** [[../tables/subscriptions]], [[../lifecycles/subscription-billing]], [[../lifecycles/cancel-flow]], [[../lifecycles/dunning]], [[../lifecycles/return-pipeline]].

## Mandates (perpetual)

### Subscription continuity & billing integrity
Keep every subscriber billed correctly and on-plan — the subscription engine never drops, double-charges, or loses a customer's grandfathered price; the Appstle→in-house migration preserves each customer's charge.
- **Metric:** billing-error rate → 0; grandfathered-price preservation across migration.
- **Specs:** Appstle pricing heal + migration monitor — ✅ verified + archived (folded → [[../lifecycles/subscription-billing]] § Migration path · [[../archive]]).

### Churn prevention & win-back
Reduce voluntary + involuntary churn via the cancel-flow, dunning recovery, and reactivation. (Currently shipped as lifecycles; future specs land here.)
- **Owns lifecycles:** [[../lifecycles/cancel-flow]], [[../lifecycles/dunning]].

## Owned / contributed goals

- Contributes to [[../goals/ceo-mode]] — the Retention director seat (subscriber base = the recurring-revenue engine behind enterprise value).

## Status

Charter doc. First owned spec: Appstle pricing heal + migration monitor — ✅ verified + archived ([[../archive]]).
