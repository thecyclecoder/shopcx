import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthedUser } from "@/lib/auth"; // db-load-auth-cache
import { getActiveWorkspaceId, getUserWorkspaces } from "@/lib/workspace";
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

  return (
    <WorkspaceProvider value={{ id: current.id, name: current.name, role: current.role }}>
      <SectionNavProvider>
      <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
        <Sidebar
          workspace={current}
          user={{
            id: user.id,
            email: user.email!,
            // user_metadata is typed as Record<string, unknown> when the
            // db-load-getclaims path maps the JWT claim to a user shape.
            name:
              (user.user_metadata?.full_name as string | undefined) ||
              (user.user_metadata?.name as string | undefined),
          }}
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
