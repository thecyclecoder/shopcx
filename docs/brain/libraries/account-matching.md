# libraries/account-matching

Address-aware, **confidence-graded** name/phone/email match heuristics for proposing account links.
Account linking is FUNDAMENTAL to ticket handling (CLAUDE.md): a customer's real subscription / order /
charge frequently lives on an unlinked SECOND account, so a matcher must (a) find same-person accounts
that aren't linked yet — not just resolve an existing link group — and (b) grade its confidence so a
COMMON NAME doesn't drown the one real duplicate.

**File:** `src/lib/account-matching.ts`

## Confidence grading + the db8b3d66 wedge

`findUnlinkedMatches` returns `PotentialMatch { id, email, confidence: 'high'|'low', signals[], previously_rejected }`:

- **`high`** — a shared street **address** (address1 + zip, normalised) that corroborates a shared last
  name, OR a shared **phone**. A signal a common name can't fake — safe to prompt/propose a link on.
- **`low`** — name-only / email-local-only. Real for a rare name, noise for a common one. Surface, never auto-link.

**Rejection semantics changed:** a previously-rejected pair (`customer_link_rejections`) suppresses a
**`low`** match, but a **`high`** match RE-SURFACES with `previously_rejected: true` (a re-confirm, never a
silent auto-link). This is the fix for ticket **db8b3d66**: "Elizabeth Johnson" matched 16 namesakes under
name-only matching; a single bulk "reject all" swept her REAL same-address second account (`rustin94@gmail.com`,
an active $236.50 sub) into the rejection set, permanently hiding it — so Sol AND June truthfully but wrongly
reported "no active subscription / no such charge" while the sub kept billing on the sibling. Address was
never weighed. Now it is, and a weak rejection can no longer bury a strong same-person match.

Address is corroborated **in memory** over the small (≤20) name/phone/email candidate set already fetched
by id — no unindexed address scan. The grading itself is the pure, unit-pinned `gradeUnlinkedCandidates`
(`account-matching.test.ts`). `hasHighConfidenceUnlinkedMatch` is the boolean Sol/June act on.

## Where it surfaces

- **Always-loaded customer context** (`sonnet-orchestrator-v2.ts` `get_customer_account`) prints
  **⚠️ LIKELY SAME-PERSON UNLINKED ACCOUNT(S)** for high-confidence siblings — every agent that reads the
  customer account (Sol, June, orchestrator) sees it and must check the sibling before concluding "no such account/charge".
- **`get_link_candidates`** + **`search_orders`** (cross-customer charge search by amount/date/email) are
  read-only Sol/June tools ([[improve-tools]] · `scripts/improve-box-tools.ts` allowlist) — the CS SDK for
  reconciling a disputed "$X on `<date>`" charge that lives on an unlinked account.

## File header

```
Account Matching — single source of truth for finding potential linked accounts.
Used by: unified ticket handler (detection), journey step builder (building steps),
and any future account linking logic.
```

## Exports

### `findUnlinkedMatches` — function

```ts
async function findUnlinkedMatches(workspaceId: string, customerId: string, adminClient?: Admin,) : Promise<PotentialMatch[]>
```

### `PotentialMatch` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

- **Per-branch indexed queries, not one mixed `.or()`.** `findUnlinkedMatches` matches on three
  branches — `and(first_name, last_name)`, `phone`, and `email ilike local@%`. These run as
  **separate** queries (`Promise.all`) merged + deduped by id in memory, *not* a single
  `.or(...)`. A combined OR forced a Seq Scan of the 620k-row customers table (the
  case-insensitive email ILIKE branch is non-indexable on a plain btree, and the OR defeats the
  `workspace_id` index); concurrent portal-bootstrap / sonnet / journey-builder calls saturated
  the pool → PostgREST 500 (Control Tower signature `supabase-logs:b5db594131381078`). Each
  branch now rides its own index:
  - name → `idx_customers_name_match (workspace_id, first_name, last_name)`
  - phone → `idx_customers_phone (workspace_id, phone)` partial
  - email → `idx_customers_email_trgm` gin trgm (added 2026-06-14)
  Added in `supabase/migrations/20260706130000_account_matching_indexes.sql`. **If you add a new
  match branch, add a matching index and keep it a separate query** — never fold it back into one
  `.or()`.

## Related

[[../tables/customers]] (the indexes that back each match branch) · [[../lifecycles/customer-link-confirmation]] (where matches become link proposals) · [[../journeys/account-linking]] · [[../dashboard/control-tower]] (signature `supabase-logs:b5db594131381078` that surfaced the Seq Scan)

---

[[../README]] · [[../../CLAUDE]]
