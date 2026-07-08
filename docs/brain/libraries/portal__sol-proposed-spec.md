# libraries/portal/sol-proposed-spec

Sol's OPTIONAL "propose a code-fix spec" output on a portal-error ticket. Phase 2 of [[../specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]]. Dual output: Sol ALWAYS produces the customer-facing remediation (Direction + first_reply); ADDITIONALLY, when she judges the portal error has a **structural code cause**, she returns a top-level `proposed_spec` field in the same ticket-handle JSON. The worker (deterministic Node — the only mutator) authors the spec on the Roadmap via [[./author-spec]] `authorSpecRowStructured` — same shape [[./improve-plan-executor]] uses for CS ticket-derived product-fixes: **owner=`cs`**, `autoBuild=false` (lands `planned` for the human to commission), and a `**Derived-from-ticket:** \`<ticket-id>\`` line in the summary. A one-off / self-inflicted portal error yields no `proposed_spec` and no spec noise.

**File:** `src/lib/portal/sol-proposed-spec.ts`

## What it does

Sol's ticket-handle JSON now carries an optional `proposed_spec` field alongside `direction` + `first_reply`. On the worker side ([[../inngest/../../scripts/builder-worker.ts]] `runTicketHandleJob`) we gate on `params.reason === "portal_error"` and pass `proposed_spec` through a two-step pipeline:

1. **`validateSolProposedSpec(raw)`** — pure validator. Normalizes `slug` (kebab-case sanitize, collapse dash runs, trim), requires non-empty `title`/`intent`/`problem`, accepts optional `mandate`. Returns `null` for the one-off portal error case (missing / blank / wrong-type fields OR no `proposed_spec` field at all). The worker's presence-check on the return value is what skips the spec author on that branch.
2. **`authorSolProposedPortalErrorSpec(workspaceId, ticketId, spec)`** — impure wrapper. Resolves CS function mandates, calls `authorSpecRowStructured` with the pure-built args, and captures the anchored mandate.

Under the hood the wrapper composes three pure helpers:

| Helper | Returns | What it captures |
|---|---|---|
| `validateSolProposedSpec(raw)` | `SolProposedSpec \| null` | Normalized shape, or `null` on missing fields (the one-off branch) |
| `buildPortalErrorSpecFields(spec, ticketId)` | `{ summary, phaseBody, phaseVerification }` | Roadmap-visible copy with the `**Derived-from-ticket:** \`<id>\`` anchor |
| `buildAuthorSpecArgs(ticketId, spec, csMandates)` | `{ slug, input, opts, matchedMandate }` | Exact args `authorSpecRowStructured` will receive — owner=cs, autoBuild=false, parent anchored to mandate slug or falls back to `[[../functions/cs]]` |

## Design decisions

- **Structural vs. one-off is Sol's call — encoded as PRESENCE.** The dual output rule lives in the ticket-handle skill (`.claude/skills/ticket-handle/SKILL.md`). Sol includes `proposed_spec` for a product/infrastructure gap, UI regression, or recurring class of failure; she omits it for a one-off customer state, a self-inflicted action, or an error already tracked by an in-flight spec. Silence IS the signal — the worker's presence check on `validateSolProposedSpec`'s return value skips the spec author cleanly.
- **Portal-only reason gate.** The worker only reads `proposed_spec` when `params.reason === "portal_error"` (the Phase-1 enqueue helper sets exactly that reason). A non-portal ticket-handle (`first_touch` / `inflection` — see [[./inflection-detector]]) that smuggled a `proposed_spec` through the JSON is a no-op. This is Learning #2: the confirming predicate at the mutating action point, not a coarser proxy — a workspace's inbound-message first-touch can't accidentally fan out a code-fix spec.
- **Pure input builders + a thin impure wrapper.** The three pure helpers hold the artifact-visible shape (owner, autoBuild, Derived-from-ticket ref, parent anchoring); only `authorSolProposedPortalErrorSpec` reaches for `authorSpecRowStructured` and `resolveFunctionMandates`. Unit tests exercise the pure helpers — the wire-in to `runTicketHandleJob` is a trivial `if (validate) { author }`.
- **Mandate resolution mirrors improve-plan-executor.** When Sol names a real CS mandate (`spec.mandate` matches a slug from [[../functions/cs]]), we anchor UP-FRONT with `parentKind='mandate'` + `parentRef='cs#<slug>'`. When she omits it or picks an unknown slug, we pass the bare `[[../functions/cs]]` parent and let the [[./author-spec]] Phase-2 auto-anchor pick the best fit; the `onAutoAnchor` callback captures which mandate the chokepoint chose so the worker can log the anchor decision.
- **`intendedStatusSetBy = "box:sol-ticket-handle"`.** Distinct from `improve-plan-executor`'s `"box:ticket-improve"` so the audit trail on `specs.intended_status_set_by` distinguishes Sol's first-touch dual-output author from Improve co-pilot author.
- **Spec author failure does NOT unwind the customer fix.** The Direction + first_reply have already landed (durable state + customer-visible side effect). A failed `authorSpecRowStructured` call is logged in the worker's log_tail and the job still completes — the CS Director can commission the spec by hand from the Improve tab if the failure was transient.

## Exports

- `validateSolProposedSpec(raw: unknown)` → `SolProposedSpec | null` — pure validator/normalizer.
- `buildPortalErrorSpecFields(spec, ticketId)` → `{ summary, phaseBody, phaseVerification }` — the Roadmap-visible copy.
- `buildAuthorSpecArgs(ticketId, spec, csMandates)` → `{ slug, input, opts, matchedMandate }` — the exact args passed to `authorSpecRowStructured`.
- `authorSolProposedPortalErrorSpec(workspaceId, ticketId, spec)` → `AuthorSolProposedSpecResult` — impure wrapper.
- `SolProposedSpec` interface — the shape Sol returns.

## Callers

- `scripts/builder-worker.ts` — `runTicketHandleJob`. Right after Sol's `first_reply` is delivered, when `params.reason === "portal_error"`, the worker validates any `proposed_spec` and (on non-null) calls `authorSolProposedPortalErrorSpec`.

## Related

- [[./enqueue-sol-first-touch]] — Phase 1: the portal-intake enqueue with `reason: "portal_error"` that triggers this dual-output rule.
- [[./author-spec]] `authorSpecRowStructured` — the chokepoint every spec author flows through.
- [[./improve-plan-executor]] — the sibling ticket-derived spec author, used by the Improve co-pilot lane.
- [[./ticket-directions]] — the M1 Direction SDK Sol authors alongside the customer fix.
- [[./portal__remediation]] — the auto-heal / dismiss / escalate lane (unchanged; a Phase-3 rail hit later remaps its escalate() to Sol's June escalation).

---

[[../README]] · [[../../CLAUDE]] · [[../specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]]
