# libraries/playbook-compiler

Read + write chokepoints for the playbook-compiler box agent (kind `playbook-compile`).

**File:** `src/lib/playbook-compiler.ts`.

Phase 1 of [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]]: this module used to be a raw-Anthropic-API loop drafting `sonnet_prompts` rows. That path is **gone** — no code path here calls Fable or a raw external model API. What remains is the pure clustering helpers + the box-agent I/O:

- **Read** — `loadPlaybookCompileBrief(admin, workspaceId)` builds the FULL-history brief the box agent reasons over (tickets + `ticket_analyses`, no 30-day floor).
- **Write** — `applyBoxPlaybookCompile(admin, { workspaceId, jobId, verdict })` upserts each tree from the agent's verdict into [[../tables/compiled_trees]] AND (Phase 2) upserts one PROPOSED `playbooks` row per tree (`is_active=false`, `proposed_by='playbook_compiler'`, `source_tree_key=tree.tree_key`) + its `playbook_steps`, and writes ONE [[director_activity]] row (`director_function='cs'`, `action_kind='compiled_trees_extracted'`, `phase=2`).
- **Approve** — `approvePlaybookProposal(admin, { workspaceId, playbookId, approverUserId? })` is the human-gated activation chokepoint. Compare-and-sets: `.eq('proposed_by', 'playbook_compiler').eq('is_active', false)` — so an already-approved / human-authored / cross-workspace row can never be reflipped. Flips `is_active=true` + clears `proposed_by=null` in one write and records a [[director_activity]] `action_kind='playbook_seed_approved'` row.

The agent (Max `claude -p`) emits the verdict; the DETERMINISTIC worker is the only mutator. Same supervisable-autonomy pattern as [[cs-director]] / [[deploy-guardian]] — north star: CEO → role agent → bounded tool.

## Exports

| Symbol | What |
|---|---|
| `DEFAULT_SUPPORT_MIN` | Default distinct-ticket threshold to qualify a tree for Phase-2 playbook proposal (15). Per-workspace override on `workspaces.playbook_compiler_support_min`. |
| `MINING_WINDOW_DAYS` | LEGACY constant retained for Phase-3-of-the-original-loop test compatibility. Not used by the full-history box agent. |
| `extractActionTypes(options, chosen)` | Walks a `ticket_resolution_events.options[chosen.option_index].action_shape` tree and returns the sorted-unique action-type tuple. Multi-action shapes surface intact. |
| `bucketClusters(rows)` | Buckets confirmed resolution rows into `(problem, action_types)` [[Cluster]]s, keyed by `treeKeyFor`. Rows missing `problem` or with no derivable `action_types` drop; support counts distinct `ticket_id`s. |
| `treeKeyFor(problem, action_types)` | Deterministic string builder — the agent's proposed `tree_key` MUST equal this. The store's UNIQUE `(workspace_id, tree_key)` anchors idempotency on it. |
| `loadSupportMin(admin, workspaceId)` | Reads the per-workspace override; falls back to `DEFAULT_SUPPORT_MIN`. Best-effort. |
| `listCompilableWorkspaces(admin)` | Enumerates workspaces with any mineable `ticket_analyses` OR confirmed `ticket_resolution_events` — the Inngest cron's enqueuer input. Best-effort (returns `[]` on a read failure). |
| `loadPlaybookCompileBrief(admin, workspaceId)` | Builds the FULL-history brief (resolution rows + analyses + precomputed clusters + a formatted header the box agent Reads). No 30-day floor. |
| `loadPlaybookCompileBriefFromWorkspaceId(workspaceId)` | Convenience wrapper — creates an admin client. |
| `normalizePlaybookCompileVerdict(raw)` | Shape guards + `tree_key` re-derivation over an agent verdict. Returns `null` on a total shape miss; the runner surfaces that as `needs_attention`. |
| `applyBoxPlaybookCompile(admin, {workspaceId, jobId, verdict})` | The write chokepoint. Upserts each tree to [[../tables/compiled_trees]] with `onConflict: "workspace_id,tree_key"`, then (Phase 2) upserts one PROPOSED playbook per tree with `onConflict: "workspace_id,source_tree_key"` + refreshes `playbook_steps` for the seed's own playbook_id (never a workspace-wide broadcast), and writes ONE [[director_activity]] row summarizing. Guard-before-mutation: the step refresh runs ONLY when the upserted playbook row still has `proposed_by='playbook_compiler' AND is_active=false` — a human-activated seed is left alone. Best-effort per row — an upsert error on one tree logs + skips it; a director_activity write failure never rolls back the persisted rows. |
| `PLAYBOOK_COMPILER_PROPOSED_BY` | The `'playbook_compiler'` provenance tag stamped on every compiler-seeded `playbooks.proposed_by`. Approval clears it to null. |
| `proposedPlaybookName(tree)` | Deterministic human-readable name from a `CompiledTreeVerdict` — `"Compiler seed — <problem> → <action_type_a> + <action_type_b>"`. Pure. |
| `buildProposedPlaybookRow(workspaceId, tree)` | Pure builder for the compiler-seeded `playbooks` INSERT payload. Hard-pins `is_active: false as const` + `proposed_by: PLAYBOOK_COMPILER_PROPOSED_BY`. `trigger_intents` are the top-N by ticket_count from `tree.intent_distribution` (the analyzer's REAL tags, NEVER hand-guessed keywords — the Phase-2 verification invariant). |
| `buildProposedPlaybookStepRows(workspaceId, playbookId, tree)` | Pure builder for the compiler-seeded `playbook_steps` INSERT payloads. Every step lands `type='custom'` with the orchestrator `action_type` + notes in `config` — the CHECK-constrained fine-grained step types are for human-authored steps only. Falls back to `tree.action_types` when the resolution_sequence is empty. |
| `approvePlaybookProposal(admin, {workspaceId, playbookId, approverUserId?})` | Human-gated activation. Compare-and-sets on `.eq('proposed_by', PLAYBOOK_COMPILER_PROPOSED_BY).eq('is_active', false)` — an already-approved / cross-workspace / human-authored row can never be reflipped. Records a `playbook_seed_approved` [[director_activity]] row on success. |
| `listApprovedCompiledPlaybooks(admin, workspaceId)` | **Phase 3** — DB-driven reader for approved compiler-derived playbooks. Predicate: `is_active=true AND proposed_by IS NULL AND source_tree_key IS NOT NULL`. Sol's first-touch session pulls this alongside the built-in `.from("playbooks").eq("is_active", true)` catalog so a compiler-derived option can be flagged as data-grounded in reasoning. Best-effort. |
| `listCompiledTrees(admin, workspaceId, {minSupport?, limit?})` | **Phase 3** — DB-driven reader for the persisted trees in [[../tables/compiled_trees]], highest-support first. Sol's session reads this as CONTEXT even when no compiler playbook is approved yet — the trees are evidence of "N tickets landed here" the model can lean on. Default limit 20. Best-effort. |
| `buildCompiledLibraryPromptSection(approved, trees)` | **Phase 3** pure formatter — folds the two lists into ONE system-prompt section. Empty inputs → `""` (never a `(none)` false negative). |
| `loadCompiledLibraryPromptSection(admin, workspaceId, {treesLimit?, treesMinSupport?})` | **Phase 3** wire point. One-call helper Sol's `buildPreContext` ([[../libraries/sonnet-orchestrator-v2]]) awaits inside its Promise.all — runs both reads in parallel and returns the composed string. Per-workspace, so it sits INSIDE the stable system prompt without invalidating the shared prefix. |

## Types

- `Cluster` — the pure clustering shape (`problem`, `actionTypes`, `key`, `support`, `sampleTicketIds`).
- `IntentDistributionEntry` — a single `{intent, ticket_count}` entry in the intent distribution the box agent surfaces per tree.
- `CompiledTreeVerdict` — one tree the agent emits + the runner upserts verbatim.
- `PlaybookCompileVerdict` — the full JSON verdict `{trees, reasoning}`.
- `ApplyPlaybookCompileResult` — the runner's post-write summary (`treesUpserted`, `proposedPlaybooksUpserted`, `proposedStepsInserted`, `reasonSkipped`).
- `ApprovePlaybookProposalResult` — `{ ok: boolean, reason?: string }` returned by `approvePlaybookProposal`. `reason='already_active_or_not_a_seed'` when zero rows transition.
- `PlaybookCompileScope` — one entry in `listCompilableWorkspaces`'s output (`workspaceId`, `ticketAnalysisCount`, `confirmedResolutionCount`).
- `PlaybookCompileBrief` — the loaded brief the runner hands to the agent (`supportMin`, `resolutionRows`, `analysisRows`, `precomputedClusters`, `headerText`).
- `FullHistoryResolutionRow`, `FullHistoryAnalysisRow` — the shapes read from `ticket_resolution_events` + `ticket_analyses`.
- `ApprovedCompiledPlaybook` — Phase 3 row shape returned by `listApprovedCompiledPlaybooks`.
- `CompiledTreeRow` — Phase 3 row shape returned by `listCompiledTrees`.
- `ListCompiledTreesOptions` — `{minSupport?, limit?}` knobs for `listCompiledTrees`.

## Callers

- **Inngest cron** — [[../inngest/playbook-compiler]] `playbookCompilerCron` calls `listCompilableWorkspaces` to decide which workspaces get a `playbook-compile` agent_job enqueued.
- **Box worker** — `scripts/builder-worker.ts` `runPlaybookCompileJob` calls `loadPlaybookCompileBrief`, `normalizePlaybookCompileVerdict`, and `applyBoxPlaybookCompile`.
- **Sonnet orchestrator (Sol's first-touch)** — [[sonnet-orchestrator-v2]] `buildPreContext` awaits `loadCompiledLibraryPromptSection` inside its per-workspace Promise.all and injects the returned string into the stable system prompt right after `buildPromptSections` (Phase 3 of [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]]).

## Invariants

- **No raw external model API call.** Every prior `fetch("https://api.anthropic.com/…")` is gone; the ONLY LLM in the loop is the box agent itself (a Max `claude -p` session, no `ANTHROPIC_API_KEY`).
- **The agent NEVER mutates.** All writes go through `applyBoxPlaybookCompile`, called only by the deterministic runner. The agent's final message is one JSON object.
- **Idempotent by construction.** `tree_key = treeKeyFor(problem, action_types)` + UNIQUE `(workspace_id, tree_key)` — a re-run over unchanged history upserts the same rows.
- **Best-effort audit.** `applyBoxPlaybookCompile` best-efforts the director_activity write — an audit hiccup MUST NOT roll back the persisted trees (mirrors [[director-activity]] `recordDirectorActivity`).
- **Compiler NEVER inserts an active playbook.** Enforced at CI by `scripts/_check-playbook-compiler-no-active.ts` (Phase 2 verification bullet: "A grep/audit confirms the compiler never inserts an active playbook directly"). The check strips comments and masks the sanctioned `approvePlaybookProposal` function, then greps for any remaining `is_active: true` in the compiler code.
- **Guard-before-mutation on step refresh.** The `applyBoxPlaybookCompile` step-refresh sub-path re-asserts `proposed_by=PLAYBOOK_COMPILER_PROPOSED_BY` and `is_active=false` on the just-upserted row before deleting/re-inserting steps — a human-activated seed retains its human-edited steps.
- **Sol's option set is DB-driven, never hardcoded** (Phase 3 verification bullet). `listApprovedCompiledPlaybooks` runs the exact predicate the spec pins (`is_active=true AND proposed_by IS NULL AND source_tree_key IS NOT NULL`); retiring or approving a seed changes the returned rows immediately. Pinned by `src/lib/playbook-compiler-sol.test.ts` "DB-driven — flipping is_active=false empties the option set".

## Related

- Store: [[../tables/compiled_trees]] (the durable substrate this library writes to).
- Cron: [[../inngest/playbook-compiler]] (the enqueuer).
- Worker: `scripts/builder-worker.ts` → `runPlaybookCompileJob` — the box-lane dispatcher.
- Skill: `.claude/skills/playbook-compile/SKILL.md` — the agent's instructions.
- Parent spec: [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]].

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
