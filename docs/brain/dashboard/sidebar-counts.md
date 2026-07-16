# Dashboard · sidebar-counts

Consolidated badge-count endpoint for the always-mounted dashboard sidebar. ONE authenticated GET
returns every sidebar badge count in a single JSON blob, replacing the 13-17 per-badge fetches the
sidebar previously fired every 60 seconds per open dashboard tab.

**Route:** `/api/dashboard/sidebar-counts` (GET only)

## Why

The dashboard sidebar (`src/app/dashboard/sidebar.tsx`) mounts on every dashboard route and
polled 13-17 authenticated endpoints every 60s to keep badge counts fresh. Each per-badge fetch
paid its own `auth.getUser()` + PostgREST `set_config` preamble, feeding both the auth bucket and
the top `set_config`-class high-volume queries. With 3 open dashboard tabs the fan-out drove
~6.8K/hr of authed fetches; +2.3K/hr per additional open tab.

`db-load-cut-getspec-amplifier-claim-fan-sidebar-spray` Phase 3 collapses this to ONE authenticated
call per 60s tick per open tab.

## Response shape

```ts
export interface SidebarCountsResponse {
  role: WorkspaceRole;
  ticket_views: SidebarTicketView[];        // saved views + per-view counts (capped at 100/view)
  escalation: { open: number; pending: number; closed: number }; // escalation_mine buckets
  fraud: { count: number; maxSeverity: "low" | "medium" | "high" } | null; // admin/owner only
  pending_reviews: number;                  // product_reviews.status = 'pending'
  todos_approvable: number;                 // pending agent_todos this role can approve
  rejected_me: number;                      // "rejected → me" pile from /api/escalated
  improve_waiting: number | null;           // owner/admin/cs_manager only
  branches: number | null;                  // owner/admin only (GitHub open claude/* PRs)
  owner: {                                  // owner only — null for everyone else
    human_test_waiting: number;
    regressions: number;
    approvals_escalated: number;
    security_surfaced: number;
    lander_uploads_pending: number;
  } | null;
}
```

## Underlying reads

Each field is derived from the SAME underlying query its pre-consolidation per-badge endpoint used,
so counts match what the badge showed before:

| Field                          | Underlying source                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `ticket_views`                 | `ticket_views` (own rows) + per-view `tickets` count (capped 100, snoozed excluded)   |
| `escalation.{open,pending,closed}` | `tickets` head:true counts with `escalation_mine` predicate — 3 parallel queries  |
| `fraud`                        | `fraud_cases` head:true count + newest severity (admin/owner)                          |
| `pending_reviews`              | `product_reviews` head:true count where `status='pending'`                             |
| `todos_approvable`             | `agent_todos` where `status='pending'`, filtered by `canApprove(role, action_type)`    |
| `rejected_me`                  | `tickets` escalated to me + open status + at least one rejected `agent_todos` row      |
| `improve_waiting`              | `ticket_improve_chats` derive `queue_state` + unread — owner/admin/cs_manager only     |
| `branches`                     | GitHub `GET /repos/.../pulls?state=open`, filter `head.ref.startsWith("claude/")`      |
| `owner.human_test_waiting/regressions` | `getHumanTestQueue(workspaceId).counts.{waiting,regressions}`                  |
| `owner.approvals_escalated`    | `countEscalatedApprovals(admin, workspaceId)`                                          |
| `owner.security_surfaced`      | `countOpenSecurityReviews(admin, workspaceId)`                                         |
| `owner.lander_uploads_pending` | `listBlueprints({status:'awaiting_upload'})` + `listContentGaps({status:'open'})`      |

## Permissions

- Every caller must be an authenticated workspace member (role read from `workspace_members`).
- Owner-only fields (the `owner` bundle) are null for non-owners — enforced server-side.
- Admin/owner-only fields (`fraud`, `branches`) are null for viewers/CS/etc.
- CS-manager-and-above fields (`improve_waiting`) are null for others.

## Fail-open contract

Every count is wrapped in a `safe(promise, default)` helper: a partial DB / GitHub failure returns
that field's default value (0 / null) without blanking the whole response. A single slow query never
strands the badge poll.

## Files

- `src/app/api/dashboard/sidebar-counts/route.ts` — the endpoint (this route).
- `src/app/dashboard/sidebar.tsx` — the caller (polls this endpoint every 60s, visibility-gated).

---

[[../README]] · [[../../CLAUDE]]
