# libraries/playbook-compiler

Read + write chokepoints for the playbook-compiler box agent (kind `playbook-compile`).

**File:** `src/lib/playbook-compiler.ts`.

Phase 1 of [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]]: this module used to be a raw-Anthropic-API loop drafting `sonnet_prompts` rows. That path is **gone** — no code path here calls Fable or a raw external model API. What remains is the pure clustering helpers + the box-agent I/O:

- **Read** — `loadPlaybookCompileBrief(admin, workspaceId)` builds the FULL-history brief the box agent reasons over (tickets + `ticket_analyses`, no 30-day floor).
- **Write** — `applyBoxPlaybookCompile(admin, { workspaceId, jobId, verdict })` upserts each tree from the agent's verdict into [[../tables/compiled_trees]] and writes ONE [[director_activity]] row (`director_function='cs'`, `action_kind='compiled_trees_extracted'`).

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
| `applyBoxPlaybookCompile(admin, {workspaceId, jobId, verdict})` | The write chokepoint. Upserts each tree to [[../tables/compiled_trees]] with `onConflict: "workspace_id,tree_key"` and writes ONE [[director_activity]] row summarizing. Best-effort per row — an upsert error on one tree logs + skips it; a director_activity write failure never rolls back the persisted trees. |

## Types

- `Cluster` — the pure clustering shape (`problem`, `actionTypes`, `key`, `support`, `sampleTicketIds`).
- `IntentDistributionEntry` — a single `{intent, ticket_count}` entry in the intent distribution the box agent surfaces per tree.
- `CompiledTreeVerdict` — one tree the agent emits + the runner upserts verbatim.
- `PlaybookCompileVerdict` — the full JSON verdict `{trees, reasoning}`.
- `ApplyPlaybookCompileResult` — the runner's post-write summary (`treesUpserted`, `reasonSkipped`).
- `PlaybookCompileScope` — one entry in `listCompilableWorkspaces`'s output (`workspaceId`, `ticketAnalysisCount`, `confirmedResolutionCount`).
- `PlaybookCompileBrief` — the loaded brief the runner hands to the agent (`supportMin`, `resolutionRows`, `analysisRows`, `precomputedClusters`, `headerText`).
- `FullHistoryResolutionRow`, `FullHistoryAnalysisRow` — the shapes read from `ticket_resolution_events` + `ticket_analyses`.

## Callers

- **Inngest cron** — [[../inngest/playbook-compiler]] `playbookCompilerCron` calls `listCompilableWorkspaces` to decide which workspaces get a `playbook-compile` agent_job enqueued.
- **Box worker** — `scripts/builder-worker.ts` `runPlaybookCompileJob` calls `loadPlaybookCompileBrief`, `normalizePlaybookCompileVerdict`, and `applyBoxPlaybookCompile`.

## Invariants

- **No raw external model API call.** Every prior `fetch("https://api.anthropic.com/…")` is gone; the ONLY LLM in the loop is the box agent itself (a Max `claude -p` session, no `ANTHROPIC_API_KEY`).
- **The agent NEVER mutates.** All writes go through `applyBoxPlaybookCompile`, called only by the deterministic runner. The agent's final message is one JSON object.
- **Idempotent by construction.** `tree_key = treeKeyFor(problem, action_types)` + UNIQUE `(workspace_id, tree_key)` — a re-run over unchanged history upserts the same rows.
- **Best-effort audit.** `applyBoxPlaybookCompile` best-efforts the director_activity write — an audit hiccup MUST NOT roll back the persisted trees (mirrors [[director-activity]] `recordDirectorActivity`).

## Related

- Store: [[../tables/compiled_trees]] (the durable substrate this library writes to).
- Cron: [[../inngest/playbook-compiler]] (the enqueuer).
- Worker: `scripts/builder-worker.ts` → `runPlaybookCompileJob` — the box-lane dispatcher.
- Skill: `.claude/skills/playbook-compile/SKILL.md` — the agent's instructions.
- Parent spec: [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]].

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
