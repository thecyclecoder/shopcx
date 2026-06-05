# dashboard/branches

Single surface for every open `claude/*` PR the To-Do routine has created (from `brain_doc_edit` / `code_change` / `grader_prompt_edit` / `escalation_rule_fix` todos).

**Route:** `/dashboard/branches` · **File:** `src/app/dashboard/branches/page.tsx` · **API:** `GET /api/branches`
**Sidebar:** top-level **Branches** (owner only), bubble = number of open `claude/*` PRs.

## List
Queries the GitHub REST API for open PRs whose head ref starts with `claude/`. Columns: Title (+ branch + file count) · Source todo (links back via `execution_result.pr_url` match) · Age · CI status (combined status of the head sha: passing/failing/pending) · Mergeability · **Squash & merge** / **Open in GitHub**.

For each PR the API also does a single-PR GET (`/repos/{repo}/pulls/{number}`) — the LIST endpoint doesn't populate `mergeable` / `mergeable_state` / `changed_files`. From those it computes `safe_to_merge = mergeable === true && (mergeable_state === "clean" || "behind") && ci not in (failure, pending)`. `behind` (base advanced) is allowed — still a conflict-free squash; only `dirty`/`blocked`/`draft`/`unknown` are blocked.

Also surfaced **inline on the todo detail page** ([[tickets__todos__id]]) as a PR card whenever `execution_result.pr_url` is set.

## Merge
`POST /api/branches/[number]/merge` squash-merges a PR from the dashboard. **Owner-only** (mirrors the owner-only approval of `code_change` / `brain_doc_edit` — merging to main is owner-level). Re-validates safety **server-side** before merging (PR open, `claude/*` head, `mergeable === true`, `mergeable_state` ∈ {`clean`, `behind`}) so a stale client can't merge a conflicting/behind/blocked PR. On success it best-effort stamps the originating todo's `execution_result.merged_at` and deletes the branch. The **Squash & merge** button only renders when `safe_to_merge` AND the viewer's role is `owner`; everyone else uses **Open in GitHub**. Code still never *auto*-merges — this is a human (owner) click.

## Config
Needs a GitHub token in env: `GITHUB_TOKEN` (or `AGENT_TODO_GITHUB_TOKEN`); repo from `AGENT_TODO_REPO` (default `thecyclecoder/shopcx`). Without a token the API returns `{ configured: false }` and the page shows a setup hint.

## Auto-merge policy
- `auto_merge_brain_docs` — default false; when on, brain-doc PRs auto-merge once CI passes (low risk; revert via git).
- `auto_merge_code_changes` — **always false, hard-coded.** Code never auto-merges; merges to main are human-driven via GitHub review.
- **CI gate** — the routine runs `npx tsc --noEmit` before pushing. On failure no PR opens and the todo is `failed` with the compile error in `execution_result.error`. No broken PRs reach this surface.

## Related
[[tickets__todos__id]] · [[../tables/agent_todos]] · [[../inngest/agent-todo-routine]] · [[../lifecycles/agent-todo-system]]
