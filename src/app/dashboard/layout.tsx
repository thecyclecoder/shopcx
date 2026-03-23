import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspaceId, getUserWorkspaces } from "@/lib/workspace";
import { WorkspaceProvider } from "@/lib/workspace-context";
import Sidebar from "./sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) redirect("/workspace/select");

  const workspaces = await getUserWorkspaces(user.id);
  const current = workspaces.find((w) => w.id === workspaceId);

  if (!current) redirect("/workspace/select");

  return (
    <WorkspaceProvider value={{ id: current.id, name: current.name, role: current.role }}>
      <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
        <Sidebar
          workspace={current}
          user={{ email: user.email!, name: user.user_metadata?.full_name || user.user_metadata?.name }}
        />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </WorkspaceProvider>
  );
}
