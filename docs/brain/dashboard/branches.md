# dashboard/branches

Single surface for every open `claude/*` PR the To-Do routine has created (from `brain_doc_edit` / `code_change` / `grader_prompt_edit` / `escalation_rule_fix` todos).

**Route:** `/dashboard/branches` · **File:** `src/app/dashboard/branches/page.tsx` · **API:** `GET /api/branches`
**Sidebar:** top-level **Branches** (owner only), bubble = number of open `claude/*` PRs.

## List
Queries the GitHub REST API for open PRs whose head ref starts with `claude/`. Columns: Title (+ branch + file count) · Source todo (links back via `execution_result.pr_url` match) · Age · CI status (combined status of the head sha: passing/failing/pending) · Mergeability · **Open in GitHub**.

Also surfaced **inline on the todo detail page** ([[tickets__todos__id]]) as a PR card whenever `execution_result.pr_url` is set.

## Config
Needs a GitHub token in env: `GITHUB_TOKEN` (or `AGENT_TODO_GITHUB_TOKEN`); repo from `AGENT_TODO_REPO` (default `thecyclecoder/shopcx`). Without a token the API returns `{ configured: false }` and the page shows a setup hint.

## Auto-merge policy
- `auto_merge_brain_docs` — default false; when on, brain-doc PRs auto-merge once CI passes (low risk; revert via git).
- `auto_merge_code_changes` — **always false, hard-coded.** Code never auto-merges; merges to main are human-driven via GitHub review.
- **CI gate** — the routine runs `npx tsc --noEmit` before pushing. On failure no PR opens and the todo is `failed` with the compile error in `execution_result.error`. No broken PRs reach this surface.

## Related
[[tickets__todos__id]] · [[../tables/agent_todos]] · [[../inngest/agent-todo-routine]] · [[../lifecycles/agent-todo-system]]
