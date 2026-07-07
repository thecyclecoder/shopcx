# cs-director-digest

The **composer** behind the [[../tables/cs_director_digests]] table (Phase 1 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]).

**File:** `src/lib/cs-director-digest.ts`

Rolls up the CS Director's per-week signal into one row per (workspace, week) so the founder reads a batched digest instead of a per-ticket paging firehose. Called from the weekly [[../inngest/cs-director-digest-composer]] cron.

## Exports

| Name | Signature | Purpose |
|---|---|---|
| `composeCsDirectorDigest` | `(admin, workspaceId, since, until) → { inserted, row, storylineCount }` | Composes and inserts (or short-circuits on an existing row) one [[../tables/cs_director_digests]] row for the workspace's period. Idempotent per `(workspace_id, digest_period_start)`. Never throws. |
| `CsStoryline` | type | The `storylines[]` element shape — `{ kind, title, evidence, proposed_action: { type, payload? } }`. |
| `CsStorylineKind` | type | `'early_warning' \| 'precedent_call'`. |
| `CsStorylineProposedActionType` | type | `'widen_leash' \| 'tighten_leash' \| 'add_policy' \| 'add_rule' \| null` — the founder-actionable seed Phase 2's reply surface consumes. |
| `CsDirectorDigestRow` | type | The inserted row shape (mirrors the DB columns). |

## Sources composed

- **`director_activity`** — `director_function='cs' + action_kind='cs_director_call'` rows in the window. Each becomes ONE `precedent_call` storyline. `proposed_action.type` derives from the verdict's `metadata.decision`:
  - `escalate_founder` → `add_policy` (the CS Director hit her leash — the founder codifies the judgment)
  - `author_spec` → `add_rule` (a specific analyzer/rule gap — a `sonnet_prompts` seed until the spec ships)
  - `approve_remedy` → `null` (informational — the CS Director acted in leash)
- **`ticket_resolution_events`** — the `problem` text is normalized (whitespace collapsed + lowercased) and grouped. A problem that appears on ≥ `RECURRING_PROBLEM_THRESHOLD` (=3) DISTINCT tickets in the window becomes one `early_warning` storyline; `proposed_action.type` defaults to `add_policy` (the systemic fix is written policy, not a per-call leash tweak).

Both sources are best-effort — a failed read logs + returns `[]` for that source; the digest still ships with the surviving storylines. Never throws.

## Idempotency

Before inserting, `composeCsDirectorDigest` looks up `(workspace_id, digest_period_start)` on [[../tables/cs_director_digests]] via `existingDigestFor`. A hit returns `{ inserted:false, row: existing }` without composing — the [[../inngest/cs-director-digest-composer]] cron's `retries:1` retry can't fan out two digests for the same week, and a manual re-invocation reads back the same row.

## Invariants

- **Distinct-ticket count is the systemic signal.** `composeEarlyWarnings` counts DISTINCT `ticket_id`s per normalized problem — a problem repeated on the SAME ticket across many turns is not a systemic signal and does NOT surface as an early-warning storyline.
- **Every storyline carries a proposed_action.** Even `approve_remedy` precedents surface `{ type: null }` so Phase 2's reply surface always has a stable shape to render (an informational storyline with a disabled action panel), never a missing key.
- **Char caps on every field.** `title ≤ 160`, `evidence ≤ 800` — one digest row never balloons past a founder-readable size.

## Related

- [[../tables/cs_director_digests]] — the row this composer writes.
- [[../inngest/cs-director-digest-composer]] — the weekly cron that invokes this composer.
- [[../tables/director_activity]] · [[../tables/ticket_resolution_events]] — the source tables.
- [[../functions/cs]] · [[../goals/guaranteed-ticket-handling]] · [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]

---

[[../README]] · [[../../CLAUDE]]
