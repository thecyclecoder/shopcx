import { Suspense, type ReactNode } from "react";

// cacheComponents boundary — the audit surface reads dynamic per-workspace
// data (workspace_id from client context → fetch → analytics rollup). A
// Suspense wrapper at the segment level keeps `next build` green even if the
// child page shifts to a server-component data path later.
export default function PlaybooksAuditLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
