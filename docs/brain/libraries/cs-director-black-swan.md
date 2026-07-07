# cs-director-black-swan

The **classifier** behind Phase 2 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]].

**File:** `src/lib/cs-director-black-swan.ts`

Decides whether an `escalate_founder` `cs-director-call` verdict is a BLACK SWAN that should page the CEO in real time via [[../tables/dashboard_notifications]] instead of batching into the weekly [[../tables/cs_director_digests]] storyline digest. Anything whose harm compounds during a week-long batching lag must never wait for the Monday digest.

## Exports

| Name | Signature | Purpose |
|---|---|---|
| `classifyBlackSwan` | `({decision, reasoning, metadata}) → CsBlackSwanClassification` | Pure classifier. Returns `{ isBlackSwan, class_key?, source? }`. Always returns `{isBlackSwan:false}` for non-`escalate_founder` decisions. |
| `DEFAULT_BLACK_SWAN_CLASSES` | readonly constant | The default class + keyword list — `fraud_alert` · `chargeback_storm` · `systemic_outage`. Extension is a code change. |
| `CsBlackSwanClass` | type | Slug for the class — one of the defaults or an arbitrary string carried by verdict metadata. |
| `CsBlackSwanClassification` | type | The classifier's return shape — `{ isBlackSwan, class_key?, source? }`. |

## DB-configurable classification

"DB-configurable" here means the verdict's `metadata.black_swan_class` (or `metadata.black_swan:true`) — which the CS Director skill emits at call time and which persists to [[../tables/director_activity]] `metadata` — is what decides. The classifier prefers the explicit metadata tag; only when it's absent does it fall through to keyword-matching against the defaults. Two shapes accepted on the verdict metadata:

- `metadata.black_swan_class: 'fraud_alert' | 'chargeback_storm' | 'systemic_outage' | ...` — canonical (recommended).
- `metadata.black_swan: true` — bare flag; classified with `class_key='unspecified'` so the router still pages but the notification carries the "class not named" tag.

Default classes and their reasoning-keyword hooks (matched case-insensitively):

| `key` | `label` | Keywords |
|---|---|---|
| `fraud_alert` | Fraud alert | `fraud`, `stolen card`, `card testing`, `carding` |
| `chargeback_storm` | Chargeback storm | `chargeback storm`, `chargeback spike`, `mass chargeback`, `chargeback wave` |
| `systemic_outage` | Systemic outage | `outage`, `systemic outage`, `site down`, `store down`, `checkout down`, `widespread` |

`source` reports how the classifier decided (`verdict_metadata` vs `keyword_default`) — the [[../tables/dashboard_notifications]] page carries it so an audit can distinguish an explicit CS-Director tag from a defense-in-depth keyword hit.

## Invariants

- **Pure function.** No I/O; safe to call from a hot path.
- **Never throws.** Every input path returns a well-formed classification.
- **Non-escalate decisions never page.** Only `escalate_founder` verdicts are eligible; the other decisions have their own routing (approve → executor / author → specs SDK).

## Callers

- **`scripts/builder-worker.ts` `runCsDirectorCallJob`** — after the verdict is audited, on `decision='escalate_founder'`, the runner classifies and routes: black-swan → `dashboard_notifications` insert; non-black-swan → [[cs-director-digest]] `appendPerTicketEscalation`.

## Related

[[../tables/cs_director_digests]] · [[cs-director-digest]] · [[cs-director-digest-reply]] · [[../tables/director_activity]] · [[../tables/dashboard_notifications]] · [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]

---

[[../README]] · [[../../CLAUDE]]
