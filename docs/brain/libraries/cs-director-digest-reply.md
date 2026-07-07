# cs-director-digest-reply

The **mutation helpers** behind the founder's per-storyline bidirectional reply on the /dashboard/agents/cs-director/digests surface (Phase 2 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]).

**File:** `src/lib/cs-director-digest-reply.ts`

## Exports

| Name | Signature | Purpose |
|---|---|---|
| `widenCsLeash` | `(admin, actor) → CsDigestReplyResult` | Walk `function_autonomy` for `function_slug='cs'` up one step (off → live → live+autonomous). At-ceiling is a no-op success. Upsert on `function_slug`. |
| `tightenCsLeash` | `(admin, actor) → CsDigestReplyResult` | Walk it back one step (live+autonomous → live → off). At-floor is a no-op success. |
| `addPolicyFromStoryline` | `(admin, {workspaceId, storyline, digestId, actor}) → CsDigestReplyResult` | Insert a `policies` DRAFT row (`is_active=false`) prefilled from `storyline.evidence` / `storyline.proposed_action.payload.policy_draft`. Slug = title + digest-id-suffix. |
| `addRuleFromStoryline` | `(admin, {workspaceId, storyline, actor}) → CsDigestReplyResult` | Insert a `sonnet_prompts` PROPOSAL row (`status='proposed'`, `enabled=false`, `category='rule'`). Ships through the standard admin approve flow at /dashboard/settings/ai/prompts. |
| `stampDigestReply` | `(admin, {workspaceId, digestId, record}) → {ok, reason?}` | COMPARE-AND-SET on the digest's `ceo_replied_at IS NULL` — a stale click or replay can't overwrite an already-actioned digest. `.select("id")` asserts exactly one row transitioned. |
| `CsDigestReplyActionType` | type | `'widen_leash' \| 'tighten_leash' \| 'add_policy' \| 'add_rule'`. |
| `CsDigestReplyRecord` | type | The `ceo_reply_action` payload — carries the mutation's result-id so the audit is complete. |
| `CsLeashPos` | type | `'off' \| 'live' \| 'live_autonomous'` — the three positions of the CS leash. |

## Guard-before-mutation

Every helper follows the coaching rule for authoritative writes:

- **`function_autonomy` upsert** — the WHERE-key is `function_slug` (global config). At-ceiling / at-floor short-circuits BEFORE the write so the update is a real transition, never a same-value re-stamp.
- **`policies` insert** — `workspace_id`-scoped; `.select("id").single()` asserts exactly one row created; failure returns `{ok:false}` so the caller can NOT stamp the digest.
- **`sonnet_prompts` insert** — same shape as policies; `status='proposed'` + `enabled=false` (admin approves separately).
- **`cs_director_digests` stamp** — the compare-and-set is `.eq("id", digestId).eq("workspace_id", workspaceId).is("ceo_replied_at", null).select("id")`; a zero-row return means the digest was already stamped and the caller surfaces "already actioned" to the founder. Mutations that landed BEFORE the stamp are NOT rolled back — a policy/rule seed is safe to keep, a leash walk is idempotent per-position.

## Callers

- **`POST /api/developer/agents/cs-director/digests/[id]/reply`** — the per-storyline reply endpoint. Loads the digest, dispatches the chosen mutation, then stamps.

## Related

[[../tables/cs_director_digests]] · [[../tables/function_autonomy]] · [[../tables/policies]] · [[../tables/sonnet_prompts]] · [[cs-director-digest]] · [[../dashboard/agents-cs-director-digests]] · [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]

---

[[../README]] · [[../../CLAUDE]]
