import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthedUser } from "@/lib/auth"; // db-load-auth-cache
import { getActiveWorkspaceId, getUserWorkspaces } from "@/lib/workspace";
import { hasWorkspaceFeature, featureForHref } from "@/lib/workspace-features";
import { WorkspaceProvider } from "@/lib/workspace-context";
import { SectionNavProvider } from "@/lib/section-nav-context";
import Sidebar from "./sidebar";
import ImportProgressBar from "@/components/import-progress-bar";
import PatternReviewBanner from "@/components/pattern-review-banner";
import PullToRefresh from "@/components/pull-to-refresh";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={null}>
      <DashboardLayoutInner>{children}</DashboardLayoutInner>
    </Suspense>
  );
}

async function DashboardLayoutInner({ children }: { children: React.ReactNode }) {
  const { user } = await getAuthedUser();

  if (!user) redirect("/login");

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) redirect("/workspace/select");

  const workspaces = await getUserWorkspaces(user.id);
  const current = workspaces.find((w) => w.id === workspaceId);

  if (!current) redirect("/workspace/select");

  // workspace-feature-access Phase 2 — direct-URL guard. Hiding a sidebar link is not
  // access control: a bookmarked or typed URL must not open a page the workspace lacks.
  // The proxy stamps the request path onto `x-pathname`; resolve its feature and bounce
  // to the first enabled feature (Tickets for ShopGrowth) when it isn't granted. Superfoods
  // (enabled_features = null) is never redirected; `settings` is always allowed. API routes
  // are out of scope (already workspace-scoped).
  const enabled = current.enabled_features ?? null;
  const requestPath = (await headers()).get("x-pathname") || "";
  const requestedFeature = featureForHref(requestPath);
  if (requestedFeature && !hasWorkspaceFeature(enabled, requestedFeature)) {
    const target =
      enabled && enabled.includes("tickets")
        ? "/dashboard/tickets"
        : enabled && enabled.length > 0
          ? `/dashboard/${enabled[0]}`
          : "/dashboard/settings";
    redirect(target);
  }

  return (
    <WorkspaceProvider value={{ id: current.id, name: current.name, role: current.role }}>
      <SectionNavProvider>
      <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
        <Sidebar
          workspace={current}
          workspaces={workspaces}
          user={{ id: user.id, email: user.email!, name: user.user_metadata?.full_name || user.user_metadata?.name }}
        />
        <main className="min-w-0 flex-1 overflow-hidden pt-[calc(4rem+env(safe-area-inset-top))] md:pt-0">
          <PullToRefresh>
            <ImportProgressBar />
            <PatternReviewBanner />
            {children}
          </PullToRefresh>
        </main>
      </div>
      </SectionNavProvider>
    </WorkspaceProvider>
  );
}
