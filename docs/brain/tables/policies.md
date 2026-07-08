# policies

Canonical published policies (refund window, restocking, exchange rules, cancellation terms, etc.). Consumed by orchestrator, storefront, and (TODO) playbook executor.

**Role in customer messaging:** this table answers the *"what can we do?"* layer of customer communication. The orchestrator references it to determine eligibility (e.g. "is this refund within the 14-day window?"). The voice layer ([[../customer-voice]]) governs how the answer is delivered; the scenario-rule layer ([[sonnet_prompts]]) governs when to invoke which policy. Three-layer model fully described in [[../customer-voice]] § Three layers of customer communication.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `slug` | `text` | — |  |
| `name` | `text` | — |  |
| `version` | `int4` | — | default: `1` |
| `effective_at` | `timestamptz` | — | default: `now()` |
| `superseded_by` | `uuid` | ✓ | → [[policies]].id |
| `customer_summary` | `text` | — |  |
| `internal_summary` | `text` | — |  |
| `rules` | `jsonb` | — | default: `'[]'` |
| `is_active` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `updated_by` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `superseded_by` → [[policies]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[policies]].`superseded_by`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("policies")
  .select("id, slug, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("policies")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## How Sol uses this (first-touch box session)

Sol's ticket-handle box session ([[../libraries/ticket-directions]] · `.claude/skills/ticket-handle/SKILL.md`) reads this table on turn 1 — `loadActivePoliciesBlock(workspace_id)` in `scripts/builder-worker.ts` `loadTicketHandleBrief` selects `slug, name, internal_summary WHERE is_active = true AND superseded_by IS NULL ORDER BY slug` and appends the rows as a `CURRENT POLICIES` block in her prompt (same select shape sonnet-orchestrator-v2 uses at `:465` and ticket-analyzer at `:248` — one rulebook the entire agent layer reads from). `get_policies` in `src/lib/improve-tools.ts` re-fetches live.

Three durable rules (folded from [[../specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]] · derived-from-ticket 87ce35a1):

1. **Policy review is mandatory.** `context_summary` MUST name the specific policy (by slug or name) Sol evaluated the ask against, and state whether the ask is in-policy, in-policy with a bounded exception, or out-of-policy. Absence of a clearly-applicable policy = `needs_human`, not permission.
2. **Never bait or promise an out-of-policy outcome.** [[../libraries/sol-policy-bait-guard]] validates Sol's DRAFT `first_reply` before the send fires — an out-of-policy verdict + a promised remedy is BLOCKED, and any reply that stacks multiple returns/refunds/labels in one turn is BLOCKED unconditionally (the returns policy caps at one MBG return per customer for life).
3. **Real playbook or honest stateless.** `chosen_path='playbook'` requires a real workspace-existing `playbook_slug`; the writer rejects an empty / whitespace / invented slug. When no playbook matches, Sol chooses `stateless` (or `needs_info`) — never fakes a playbook path.

## Gotchas

- 5 canonical policies. Replaces ~60 scattered `sonnet_prompts` rules.
- Consumed by orchestrator + storefront. Playbook executor migration is pending.
- **Active policies are a hard rail for the escalation-triage solver** ([[../specs/box-escalation-triage]]): NEVER author a `spec` (code_gap / system_gap) that contradicts an active policy. If a policy already governs the scenario, the answer is a **`customer_reply` invoking that policy**, not a feature to build — e.g. the order-cancellation policy means "we can't cancel a shipped order" is a *reply*, not a code gap. And ALWAYS pair any escalated code-gap spec with a `customer_reply` for the immediate ticket.
- **Allergy/safety reports escalate — they never auto-refund.** The `exchanges` policy's Allergy Override authorizes acknowledgment + `action_type='escalate'` for human safety review, NOT a same-turn cash refund. A replacement (prepaid return + refund_amount=0) is still allowed if the customer wants one; any cash refund routes through the [[../playbooks/refund]] playbook (return on a fulfilled order; void/cancel an unfulfilled one — never refund-to-card without a return). Hardened after ticket 46471a76 — see [[../playbooks/replacement-order]] § Allergy/safety and [[../specs/allergy-safety-escalate-not-auto-refund]].
- **The seed (`scripts/seed-policies-v1.ts`) is NOT the live source of truth — live rows drift.** Policies are dashboard-editable and several have diverged from the seed (e.g. the refund Tier-2 threshold tightened 2026-06-05). Amend a live policy with a **targeted, idempotent apply-script** that fetches the row and does anchored replacements (the `scripts/update-exchanges-allergy-escalate.ts` / `fix-pause-policy-and-grader.ts` pattern) — never re-run the full seed, which would revert drift.
- **Subscription pricing / 50%-MSRP floor:** the floor (a price the cleanup raised everyone to) is the rail [[../libraries/subscription-overcharge]] clamps the established baseline to — overcharge remediation never restores a customer below the floor, so detection never contradicts this policy.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
