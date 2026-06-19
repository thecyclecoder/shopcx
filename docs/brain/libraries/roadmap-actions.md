# libraries/roadmap-actions

The owner-gated, server-revalidated mutations behind the roadmap build console — shared by **both** the dashboard API routes and the [[../integrations/slack-roadmap-console|Slack Roadmap Console]]. The approval logic lives here **once**; there is no second copy.

**File:** `src/lib/roadmap-actions.ts`

## Why this exists

The dashboard routes (`/api/roadmap/{build,answer,approve}`, `/api/branches/[number]/merge`) used to carry their owner-check + mutation inline. The Slack console needs the *same* logic but is authenticated by a Slack HMAC signature, not a Supabase cookie. So the core moved here as plain `(workspaceId, userId)` functions; the HTTP routes and the Slack handlers both call them. Each function **re-checks the owner gate itself** (`assertOwner`) — the caller's claimed identity is never trusted. This is the security boundary; [[slack-identity]] is only a UX filter on top.

## Exports

Every function returns `ActionResult<T>` = `({ ok: true } & T) | { ok: false; status: number; error: string }` so a route maps it straight to `NextResponse` and a Slack handler maps it to an ephemeral.

### `queueRoadmapBuild(workspaceId, userId, { slug, instructions?, verify? })`
Owner-gated build dispatch. `verify:true` → `enqueue_fold` (coalesced batch fold-build). Otherwise enforces **one active build per spec** (returns `{ job, alreadyActive:true }` if one is live) then inserts a `queued` [[../tables/agent_jobs]] row. `instructions` scopes a fix-build (used by Slack `/bug`).

### `answerRoadmapBuild(workspaceId, userId, { jobId, answers })`
Writes `answers` + flips a `needs_input` job to `queued_resume`. 409 if the job isn't awaiting input.

### `approveRoadmapAction(workspaceId, userId, { jobId, actionId, decision })`
Marks one `pending_actions` item approved/declined; flips to `queued_resume` only once **every** action has a decision. 409 if not `needs_approval`.

### `mergeClaudePr(workspaceId, userId, prNumber)`
Squash-merges an open `claude/*` PR via the GitHub API, **re-validating** server-side (open · `claude/*` head · `mergeable` · `mergeable_state` clean/behind). Best-effort stamps the originating [[../tables/agent_todos]] `merged_at` + deletes the branch.

## Callers

- `src/app/api/roadmap/build/route.ts` · `src/app/api/roadmap/answer/route.ts` · `src/app/api/roadmap/approve/route.ts`
- `src/app/api/branches/[number]/merge/route.ts`
- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts` ([[../integrations/slack-roadmap-console]])

## Gotchas

- **Owner gate twice, by design.** Slack handlers pre-filter with [[slack-identity]] (`resolveSlackActor` → ephemeral "owner-only"); these functions then re-check. A spoofed/replayed Slack button can't act.
- The build route's GET (job polling) is unchanged — only the POST mutation moved here.

## Related

[[../integrations/slack-roadmap-console]] · [[slack-identity]] · [[../tables/agent_jobs]] · [[../lifecycles/roadmap-build-console]] · [[../dashboard/roadmap]] · [[../dashboard/branches]]

---

[[../README]] · [[../../CLAUDE]]
