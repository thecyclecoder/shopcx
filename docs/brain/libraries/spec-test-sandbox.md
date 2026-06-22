# libraries/spec-test-sandbox

The shared core for the box spec-test agent's **sandboxed behavioral verification** ([[../specs/spec-test-deep-verification]] Phase 2). It is the contract between the gated fixture seed, the controlled-trigger CLI, and the `spec-test` skill's SANDBOX-check classification.

**File:** `src/lib/spec-test-sandbox.ts`

## Why this exists

The spec-test agent ([[../specs/spec-test-agent]]) is read-only on real data. A whole bucket of `## Verification` bullets is behavioral — *"fire renewal-attempt → $0 comp order + event"*, *"POST approve → job flips queued_resume"*, *"✓ Tested upserts a row"* — that the agent punted to `needs_human` only because it couldn't drive a flow. Phase 2 gives it a **bounded** behavioral power: drive the flow on **dedicated `is_test` fixtures**, assert the rows/events, prove isolation, clean up. This library holds the safety machinery that keeps it bounded.

## 🚨 External side-effect firewall (the core safety rule)

A flow is driven **only if every side effect stays internal** (a DB write or an Inngest event). A flow that would call an **external API with real effect** — Amplifier fulfillment, a Braintree charge/refund, an Appstle mutation, a Resend/Twilio send, a live Meta ad pause — is **not run**; it stays `needs_human`. Three layers enforce this:

1. **`INTERNAL_ONLY_FLOWS`** — the allowlist. The CLI can only `fire`/`post` a flow registered here, and each entry declares the **precondition** that guarantees its internal-only branch. The comp-renewal HAPPY path is deliberately **not** registered (its Amplifier handoff is external) — it lives in `EXTERNAL_EDGE_EXAMPLES` as a documented non-runnable.
2. **`assertTestWorkspace(admin, workspaceId)`** — throws unless the target workspace has `is_test=true`. Makes pointing the toolkit at a real tenant impossible.
3. **No external credentials on the `is_test` workspace** (defense in depth) — even a slipped external call cannot have a real effect (`createAmplifierOrder` returns `{success:false,error:"amplifier_not_configured"}` with no network call; the Braintree gateway throws on missing creds).

The canonical example: comp renewal's *fail-closed* branch (comp sub + `comp_role` null → failed `type='comp'` txn + `subscription.comp_renewal_failed` event, **no order, no advance**) is fully internal → a SANDBOX check. Its *happy* branch's Amplifier handoff is the external edge → assert up to it, flag the handoff itself human.

## Exports

| Export | What |
|---|---|
| `SPEC_TEST_FIXTURES` | Stable fixture identity — the `is_test` workspace id, owner email, and the comp customer / comp subscription / ticket / migration_audit UUIDs. Shared by the seed + the CLI so both are idempotent and find the same rows. |
| `isSpecTestWorkspace(id)` | True iff `id` is the sandbox tenant. |
| `EXTERNAL_SIDE_EFFECT_APIS` | The catalogue the firewall forbids (`amplifier｜braintree｜appstle｜resend｜twilio｜meta｜avalara｜easypost｜shopify`) + a one-line description each. |
| `INTERNAL_ONLY_FLOWS` | The allowlist of runnable flows (`comp-renewal-failclosed`, `human-queue-resolve`, `roadmap-answer`) — each with `trigger`, `rationale`, `precondition`, `asserts`. |
| `EXTERNAL_EDGE_EXAMPLES` | Flows that LOOK eligible but cross the firewall (`comp-renewal-happy` → Amplifier, etc.) — documented so the agent classifies them `needs_human`. |
| `getSandboxFlow(id)` | Look up a registered flow. |
| `assertTestWorkspace(admin, workspaceId)` | The hard guard — throws unless `is_test=true`. |
| `ISOLATION_TABLES` / `nonTestWorkspaceFingerprint(query, testWs?)` / `diffFingerprints(before, after)` | The isolation proof — count rows + newest timestamp per mutable table for everything that is NOT the `is_test` workspace; an unchanged fingerprint across a run proves **zero writes to non-test-workspace rows**. |
| `mintOwnerCookieHeader(workspaceId)` | Mint an OWNER session server-side (service-role admin — NO password; same mechanism as [[../specs/spec-test-deep-verification]] Phase 1's browser check) and return a `Cookie:` header scoped to the `is_test` workspace, for driving owner-gated internal POSTs. |
| `resolveOwnerUserId()` | The owner's auth user id (via `generateLink`, no email sent) — used by the seed to add the owner membership. |

## Callers

- `scripts/seed-spec-test-fixtures.ts` — the **gated** (owner-approved) idempotent fixture seed.
- `scripts/spec-test-sandbox.ts` — the controlled-trigger CLI (`info｜isolation｜fire｜post｜cleanup`).
- the `spec-test` skill (`.claude/skills/spec-test/SKILL.md`) + `runSpecTestJob` ([[../../../scripts/builder-worker.ts]]) — classify a behavioral bullet as a SANDBOX check.

## Fixtures (no new table — the `is_test` column + stable UUIDs)

There is **no `spec_test_fixtures` table**. Fixtures are ordinary rows in the real tables, isolated by belonging to the one `is_test` [[../tables/workspaces]] (`is_test=true`, the sentinel column added in migration `20260622120000_workspaces_is_test.sql`). "Scope to the test workspace" reduces to `workspace_id = SPEC_TEST_FIXTURES.workspaceId`; the safety assertion ("zero non-test writes") reduces to "no row with a different `workspace_id` changed" — exactly what `nonTestWorkspaceFingerprint` measures. Seed/reset is the recipe in [[../recipes/build-box-setup]].

## Related

[[../specs/spec-test-deep-verification]] · [[../specs/spec-test-agent]] · [[../tables/workspaces]] (`is_test`) · [[../tables/subscriptions]] (`comp`) · [[../tables/customers]] (`comp_role`) · [[../tables/customer_events]] · [[../tables/triage_runs]] · [[../inngest/internal-subscription-renewals]] · [[../recipes/build-box-setup]] · [[../README]] · [[../../CLAUDE]]
