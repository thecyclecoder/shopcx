import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserWorkspaces } from "@/lib/workspace";
import WorkspaceList from "./workspace-list";

export default async function SelectWorkspacePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const workspaces = await getUserWorkspaces(user.id);

  if (workspaces.length === 0) {
    redirect("/workspace/new");
  }

  if (workspaces.length === 1) {
    // Auto-select handled by client component to set cookie
    return <WorkspaceList workspaces={workspaces} autoSelect />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-md space-y-6 px-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Select a workspace
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Choose which workspace to open
          </p>
        </div>
        <WorkspaceList workspaces={workspaces} />
      </div>
    </div>
  );
}
