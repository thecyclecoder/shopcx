# libraries/slack-identity

> **Deprecated (2026-06-24):** built for the since-removed Slack roadmap console; retained as a record.

Slack user → ShopCX member bridge for the former Slack roadmap console. A **UX filter, not the security boundary** — the real gate is re-checked server-side in [[roadmap-actions]].

**File:** `src/lib/slack-identity.ts`

## Exports

### `resolveSlackActor(workspaceId, slackUserId)` — function
```ts
async function resolveSlackActor(workspaceId: string, slackUserId: string) : Promise<{ userId: string; role: string } | null>
```
Maps an inbound Slack user id → the [[../tables/workspace_members]] row via `slack_user_id` (populated at connect by `autoMapTeamMembers` / `lookupUserByEmail`). `null` = unmapped → treat as non-owner.

### `isOwner(actor)` — function
```ts
function isOwner(actor: { role: string } | null) : boolean
```
True only for `role === "owner"` — the one role allowed to mutate from Slack.

## Callers

- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts`

## Gotchas

- Resolving the actor as owner is **not** authorization — every mutating call still passes through [[roadmap-actions]], which re-checks the gate against the resolved `userId`. The Slack filter just gives non-owners a clean "owner-only" ephemeral instead of a 403.

## Related

[[roadmap-actions]] · [[slack]] · [[../tables/workspace_members]]

---

[[../README]] · [[../../CLAUDE]]
