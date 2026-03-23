"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceRole } from "@/lib/types/workspace";

interface WorkspaceContextValue {
  id: string;
  name: string;
  role: WorkspaceRole;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WorkspaceContextValue;
}) {
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
