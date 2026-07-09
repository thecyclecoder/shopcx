// Owner-role predicate for /api/growth/media-buyer/arm.
//
// Both arm→'armed' and disarm→'shadow' mutate iteration_policies.mode — a privileged
// Media Buyer mode change — and ride the service-role admin client past RLS, so the
// server MUST gate on workspace_members.role === 'owner' before touching either write
// path. Client-side button hiding is not authorization. Matches the owner-only gate on
// the other privileged growth/ads routes (e.g. api/ads/acquisition).
//
// Pulled into its own file so the predicate is unit-testable without loading Next's
// server runtime (route.ts imports next/server, which needs a build context).

export interface WorkspaceMemberRow {
  role?: string | null;
}

export function isWorkspaceOwner(member: WorkspaceMemberRow | null | undefined): boolean {
  return !!member && member.role === "owner";
}
