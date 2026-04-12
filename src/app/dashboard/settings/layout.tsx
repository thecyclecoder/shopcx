"use client";

import { useWorkspace } from "@/lib/workspace-context";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const workspace = useWorkspace();

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Access Restricted</h2>
          <p className="mt-1 text-sm text-zinc-500">Settings are only available to admins and owners.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
