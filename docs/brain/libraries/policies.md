# `src/lib/policies.ts` — policies SDK

The single sanctioned read/write surface for [[../tables/policies]] — the workspace's canonical published policies (returns / refunds / subscriptions / exchanges / crisis / cancellation / …). Established by [[../specs/a-policies-chokepoint-so-published-and-internal-rules-cannot-contradict]] to seal two failure classes at once:

1. **Fail-open policy reads.** Before this chokepoint six lib files hand-rolled `.from('policies').select(...)` and each repeated the active-and-not-superseded filter. A wrong column name silently reads as empty and the AI proceeds without the rule — the CLAUDE.md "database is the spec" failure mode.
2. **Two halves that never met.** Every row carries `internal_summary` + `rules` (what the AI obeys) and `customer_summary` (what we publish). Written months apart by different authors; never read together. On 2026-08-02 the published Order Cancellation policy shipped "You can refuse the delivery when it arrives" while three OTHER active policies say refused / return-to-sender packages arrive with no order-matchable tracking and CANNOT be refunded (Terms: "absolutely, 100% not eligible"). A real customer followed the published half and lost her refund entirely.

The SDK is the chokepoint that fixes both. See CLAUDE.md § Local conventions and [[../tables/policies]] § Two halves.

## Exports

### SDK chokepoint (Phase 1)

Enforced by [scripts/_check-policies-sdk-compliance.ts](../../../scripts/_check-policies-sdk-compliance.ts) — any `.from('policies')` outside `src/lib/policies.ts` fails the `predeploy` gate. Active-and-not-superseded filtering lives INSIDE the SDK; callers never repeat it.

| Export | Notes |
|---|---|
| `getPolicy(admin, workspaceId, slug)` | → `PolicyRow \| null`. Highest-version ACTIVE row for the slug, or `null`. Callers must NOT read `.customer_summary` and quote it as the rule — that's the published rendering, not the rule (the 2026-08-02 refuse-delivery incident). Use `internal_summary` + `rules` for enforcement decisions; use `getPolicyCustomerFacing` when rendering to a customer. |
| `listActivePolicies(admin, workspaceId)` | → `PolicyRow[]`. Every ACTIVE, non-superseded row, ordered by slug. Full rows — prefer `getInternalRules` / `getAgentPolicyPackage` when you only need the internal projection. |
| `getInternalRules(admin, workspaceId)` | → `InternalPolicyRule[]` (`{slug,name,internal_summary}`). The pre-Phase-2 agent-facing projection — INTERNAL half only, never `customer_summary`. Kept for the grader / daily-analysis-report; new agent-facing sites prefer `getAgentPolicyPackage` (which also carries the machine-readable `rules[]`). |
| `getAgentPolicyPackage(admin, workspaceId)` | → `AgentPolicyPackageEntry[]` (`{slug,name,internal_summary,rules}`). **The shared agent policy package (Phase 2).** BOTH Sol (orchestrator) and June (director brief) read this — the two agents can never reason from divergent rules again. INTERNAL half only, never `customer_summary`. |
| `formatAgentPolicyPackage(entries)` | → `string`. Renders the package into the plain-text `POLICIES (canonical — these supersede any conflicting older rule below):` block Sol's `buildPoliciesSection` and June's `loadDirectorPolicyBrief` embed. Includes each policy's `internal_summary` + a `RULES:` sub-block bulleting each machine-readable assertion. Returns `""` on empty. |
| `updatePolicyText(admin, workspaceId, slug, patch)` | → `UpdatePolicyResult` (`{id, version, versionBumped}`). In-place update of the ACTIVE row. Bumps `version` iff `customer_summary` / `internal_summary` / `rules` actually changed; a name-only or `updated_by`-only patch does not bump. Throws when no active row matches (never a silent no-op). |
| `getPolicyCustomerFacing(admin, workspaceId, slug)` | → `CustomerFacingPolicy \| null`. Storefront-shaped projection — `customer_summary` + display fields. Hides `internal_summary` + `rules` (those never belong on the customer page). |
| `insertDraftPolicy(admin, {workspaceId, slug, name, customer_summary?, internal_summary?, rules?})` | → `{id}`. DRAFT row (`is_active=false`) — the entry point for the CS digest storyline flow (`addPolicyFromStoryline` in [[cs-director-digest-reply]]), which seeds a draft the founder edits into shape from Settings → Policies before activating. Never activates on insert. |
| `PolicyRow` / `InternalPolicyRule` / `AgentPolicyPackageEntry` / `UpdatePolicyPatch` / `UpdatePolicyResult` / `CustomerFacingPolicy` / `DraftPolicyInput` | types |

## The two-halves rule (Phase 4)

Every policy row carries a **PUBLIC half** and a **PRIVATE half** and they are NOT interchangeable:

- **`internal_summary` + `rules` — AUTHORITATIVE.** What the AI obeys. Every agent-facing site reads this half (see § Agent injection points below). `rules[]` is the machine-readable half (assertions like `returns.no_refund_on_refused_or_return_to_sender`, `cancellation.never_promise_cancel_or_stop_shipment`); `internal_summary` is the human-readable rule body those assertions describe.
- **`customer_summary` — DERIVED.** The published rendering on the storefront `/policies/{slug}` help-centre page. Written from the authoritative half; NEVER a source of truth. Quoting it as the rule is a known failure mode — the **2026-08-02 refuse-delivery incident** shipped exactly that way (see spec § Why).

The chokepoint enforces this at both ends:

- The **agent-facing SDK entry points** (`getInternalRules`, `getAgentPolicyPackage`, `formatAgentPolicyPackage`) DELIBERATELY exclude `customer_summary` — an agent cannot accidentally read the published half as the rule.
- The **contradiction check** ([scripts/_check-policy-contradictions.ts](../../../scripts/_check-policy-contradictions.ts), Phase 3) scans every active policy's `customer_summary` for phrases a `rules[]` assertion on another active policy forbids and fails `predeploy` red on a match. The refuse-delivery case ships as an inline regression fixture — a code change that stops flagging it fails the build with the exact reason.

## Agent injection points (Phase 2)

The shared agent policy package (`getAgentPolicyPackage` + `formatAgentPolicyPackage`) is injected at TWO sites — Sol's orchestrator prompt and June's director brief — so the more-authoritative agent (June overrules Sol and rules on money) can never reason past a written rule the way she did on 2026-07-28 (a plain post-renewal cancellation escalated to the founder TWICE, when the Refund Policy answers it outright).

| Agent | Site | Wire-up |
|---|---|---|
| 💛 **Sol** (Direction / orchestrator) | `buildPoliciesSection` in `src/lib/sonnet-orchestrator-v2.ts` | Loaded inside the top-of-turn Promise.all alongside workflows / prompts / journeys; rendered into the `POLICIES (canonical — …)` block at the top of the system prompt so the shared prefix caches. |
| 💬 **June** (CS Director hard-call) | `loadDirectorPolicyBrief` in `src/lib/cs-director.ts`, embedded in `loadCsDirectorCallBrief` in `scripts/builder-worker.ts` | Appended to June's brief right after the CX SDK snapshot so a `cs-director-call` box session sees the SAME rulebook Sol saw when handling the ticket. Best-effort — a load failure returns a diagnostic line so the base brief still renders. |

Both sites feed **the same package** — same `getAgentPolicyPackage` call, same `formatAgentPolicyPackage` renderer — so a rule that changes in `public.policies` immediately reaches both agents on the next turn without either drifting away from the other.

The daily-analysis-report ([[daily-analysis-report]]) and the grader ([[ticket-analyzer]]) also read the same package via `getInternalRules` (the pre-Phase-2 shape). New agent-facing sites should prefer `getAgentPolicyPackage` — it also carries the machine-readable assertions an agent must not talk itself past.

## Contradiction check (Phase 3)

[scripts/_check-policy-contradictions.ts](../../../scripts/_check-policy-contradictions.ts) — wired into `predeploy` right after `check:policies-sdk-compliance`.

The check encodes forbidden paths as **assertions anchored to `rules[]` ids**, not free-prose matching. Each entry names the source policy's rule that establishes the prohibition + the customer-summary phrases that would talk past it. On run:

- Regression fixture — the 2026-08-02 refuse-delivery bad state — ALWAYS runs. A regression that stops flagging the fixture fails the build with the exact reason ("the refuse-delivery contradiction is no longer detected"). This is the spec's Phase-3 verification.
- Live-DB scan is opportunistic — reads every workspace's active policies through `listActivePolicies` when Supabase creds are present; skips gracefully with an explicit reason otherwise.
- **Loud coverage.** The summary line names: assertion count, regression PASS/FAIL, live-scan mode, per-anchor `found` vs `MISSING (drift)`, plus a `NOT COVERED` line for what is out of scope by design (prose-only contradictions in an `internal_summary` paragraph). A check that quietly covers nothing is worse than no check — the check announces what it does and does not enforce.

Adding a new contradiction class means adding a `FORBIDDEN_PATHS` entry with a clear `anchorRuleId` + the exact phrases to forbid; the coverage summary announces it on the next run.

## Callers

- [[sonnet-orchestrator-v2]] — `getAgentPolicyPackage` + `formatAgentPolicyPackage` inside `buildPoliciesSection`.
- [[cs-director]] — `getAgentPolicyPackage` + `formatAgentPolicyPackage` inside `loadDirectorPolicyBrief` (exported for the CS-director-call brief loader in `scripts/builder-worker.ts`).
- [[ticket-analyzer]] — grader system prompt reads active policies for the Rule Compliance dimension *(allow-listed raw access — migration follow-up).*
- [[daily-analysis-report]] — Opus report reads active policies so proposed rules don't contradict them.
- [[improve-tools]] — Sol's `get_policies` research tool (single by slug OR full list, both halves surfaced so Sol can see drift between what we publish and what we obey).
- [[selective-clarify]] — reads the `irreversible_actions` policy's `rules[]` to override the default irreversible action set.
- [[cs-director-digest-reply]] — `insertDraftPolicy` seeds a `policies` draft from a CS digest storyline.

## Gotchas

- **Never read `customer_summary` as the rule.** The SDK's agent-facing entry points (`getInternalRules`, `getAgentPolicyPackage`) exclude it deliberately — reach for `getPolicyCustomerFacing` only when rendering the storefront page.
- **`updatePolicyText` bumps `version` only on content change.** A name-only or `updated_by`-only patch stamps `updated_at` but keeps `version`. Callers relying on version-bump-as-audit should touch a content field.
- **`insertDraftPolicy` never activates.** The seed sets `is_active=false`; the founder activates from Settings → Policies. This matches the CS digest storyline flow's intent — a draft to review, not a live rule.
- **Live rows drift from the seed** ([[../tables/policies]] § Gotchas). The seed script is NOT the live source of truth — amend a live policy with a targeted, idempotent apply-script that fetches the row and does anchored replacements. Never re-run the seed, which would revert drift.

## Related

[[../tables/policies]] · [[sonnet-orchestrator-v2]] · [[cs-director]] · [[ticket-analyzer]] · [[daily-analysis-report]] · [[improve-tools]] · [[selective-clarify]] · [[cs-director-digest-reply]] · [[../specs/a-policies-chokepoint-so-published-and-internal-rules-cannot-contradict]] · [[../operational-rules]] · [[../../CLAUDE]]
