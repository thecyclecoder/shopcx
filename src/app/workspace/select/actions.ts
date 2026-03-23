"use server";

import { createClient } from "@/lib/supabase/server";
import { setActiveWorkspace } from "@/lib/workspace";

export async function selectWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) throw new Error("Not authenticated");

  await setActiveWorkspace(user.id, workspaceId);
}
