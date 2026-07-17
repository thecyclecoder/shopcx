# ad_creative_copy_qc_verdicts

Max's INDEPENDENT copy-QC verdict per [[ad_campaigns]] row — one row per QC attempt for a given campaign. Storage for the [[../specs/dahlia-max-independent-copy-qc-box-session]] Phase 1 keystone: the goal's line 27 requires an independent director (Max) that bounces on hard gates + records an **advisory** persuasion score without letting the rubric become a Goodhart objective. This table is the durable record so future CAC-correlation work has somewhere to read from.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `ad_campaign_id` | `uuid` | — | → [[ad_campaigns]].id · ON DELETE CASCADE |
| `hard_gate_pass` | `boolean` | — | `true` iff EVERY per-check gate in `hard_gates` is `true`. The [[../libraries/creative-qa]] `runQaCreativeCopyViaBoxSession` (Phase 2) parser treats a mismatched pair (top-level `true` with a `false` inside `hard_gates`) as a defect and fails closed. |
| `hard_gates` | `jsonb` | — | `{ no_fabrication:boolean, no_cold_offer:boolean, no_competitor_leak:boolean, single_promise:boolean, render_ok:boolean }` — the per-check hard gates from the [[../../../.claude/skills/max-copy-qc/SKILL]] verdict. Open JSON (no CHECK) so a future gate lands without a migration; the .ts parser pins the required keys. |
| `persuasion_score` | `int4` | ✓ | Max's ADVISORY 0-10 persuasion score. CHECK: `null` OR `0..10`. NULL on a hard-gate-fail verdict (the bounce IS the signal; the rubric wasn't scored). Never blocks — the caller writes the row regardless and continues the deterministic pipeline. |
| `persuasion_rubric` | `jsonb` | ✓ | Max's 5 sub-scores + evidence array, shape: `{ lf8:int, schwartz:int, cialdini:int, hopkins:int, sugarman:int, evidence:string[] }`. Each sub-score is `0..2`; `persuasion_score` equals the sum. NULL on a hard-gate fail (same reason as `persuasion_score`). |
| `scroll_stop` | `jsonb` | ✓ | Max's ADVISORY scroll-stop sub-scores from [[../specs/max-copy-qc-scroll-stop-dims]] Phase 1 — `{ headline_readable_in_3_frames:0..2, visual_hierarchy_supports_headline:0..2, first_line_earns_the_second:0..2, evidence:string[] }`. **Advisory only; never a hard-gate driver.** REQUIRED on every new verdict (parse_error if missing / null; the .ts parser refuses fail-closed) but the column stays nullable so pre-Phase-1 rows survive unchanged. The three named dimensions give future CAC correlation a granular signal beyond the rolled-up `persuasion_score`; a low sub-score with every hard gate green still passes the bin insert. |
| `verdict_reason` | `text` | ✓ | One-line "why" — the fail reason on a bounce (threaded into Dahlia's revise prompt: `'revise; Max flagged {reason}'`), or a one-line pass summary. |
| `retry_index` | `int4` | — | default: `0` · attempt number for THIS campaign. Phase 2 bounces on a hard-gate fail and increments `retry_index` on the follow-up verdict; caller enforces `retry_index < MAX_COPY_QA_ATTEMPTS` (2). Exhaustion writes a [[director_activity]] `action_kind='max_copy_qc_exhausted'` row and refuses the bin insert. |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (ON DELETE CASCADE — a workspace teardown removes the verdicts)
- `ad_campaign_id` → [[ad_campaigns]].`id` (ON DELETE CASCADE — a campaign delete removes its verdicts)

## Indexes

- `ad_creative_copy_qc_verdicts_campaign_idx (ad_campaign_id, retry_index desc)` — per-campaign read (latest attempt first).
- `ad_creative_copy_qc_verdicts_workspace_idx (workspace_id, created_at desc)` — workspace-wide reader (dashboard / CAC-correlation).

## RLS

Mirrors [[ad_campaigns]] · [[creative_test_outcomes]]:
- `ad_creative_copy_qc_verdicts_service_all` — service role does all writes.
- `ad_creative_copy_qc_verdicts_member_select` — any authenticated workspace member can select.

## Common queries

### Latest verdict for a campaign
```ts
const { data } = await admin.from("ad_creative_copy_qc_verdicts")
  .select("hard_gate_pass, persuasion_score, verdict_reason, retry_index, created_at")
  .eq("ad_campaign_id", adCampaignId)
  .order("retry_index", { ascending: false })
  .limit(1)
  .maybeSingle();
```

### Bounce rate over the last N verdicts (Goodhart-check)
```ts
const { data } = await admin.from("ad_creative_copy_qc_verdicts")
  .select("hard_gate_pass")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false })
  .limit(200);
const bounces = (data || []).filter((r) => !r.hard_gate_pass).length;
```

## Gotchas

- **`hard_gate_pass` is derived from `hard_gates`.** Never trust the top-level boolean alone — the Phase 2 parser recomputes it from the per-check payload and treats a mismatch as a defect (fail-closed). The column stores the reconciled value.
- **`persuasion_score` is ADVISORY — it never blocks the bin insert.** The whole point is to record it for future CAC correlation without letting it become the objective (Goodhart). Any code path that reads this column MUST NOT gate campaign readiness on it.
- **Writes go through the SDK helper.** Never raw `.from("ad_creative_copy_qc_verdicts").insert(...)` — the SDK-chokepoint rule (CLAUDE.md · [[../operational-rules]]) applies here too. The Phase 2 helper is `insertCopyQaVerdict` in `src/lib/ads/creative-qa.ts` (co-located with the runner + `parseCopyQaVerdict`). The helper always writes `scroll_stop` on the row — `parseCopyQaVerdict` has already fail-closed on a missing / null / out-of-range `scroll_stop` before the helper is called, so a persisted row's `scroll_stop` is a validated `CopyQaScrollStop`.
- **`scroll_stop` is ADVISORY, not a Goodhart objective.** [[../specs/max-copy-qc-scroll-stop-dims]] Phase 1 explicitly guards against a low sub-score becoming a block — the [[../libraries/creative-qa]] SDK helper writes the sub-scores REGARDLESS of their value, and no code path may gate `hard_gate_pass` on them. If a low `first_line_earns_the_second` starts predicting high CAC, the fix is a Dahlia author-mode revise directive — not a new hard gate reading off this column.
- **`retry_index` is bounded by the caller, not a CHECK.** `MAX_COPY_QA_ATTEMPTS = 2` lives in `src/lib/ads/creative-agent.ts`. Exhaustion is a [[director_activity]] escalation, not a DB error — the row still lands (the record of the exhausting attempt matters).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]] · [[../specs/dahlia-max-independent-copy-qc-box-session]] · [[../libraries/creative-qa]]
