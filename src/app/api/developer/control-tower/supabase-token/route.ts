/**
 * Owner-only Supabase access-token setup for the Control Tower error feed
 * (error-feed-monitoring Phase 2).
 *
 * The lone owner setup of the spec: paste a Supabase access token (personal/management —
 * the service-role key we have is for data, NOT logs) so the supabase-log-poll cron can
 * pull DB-level errors via the Management Logs API. Stored AES-256-GCM encrypted in
 * error_feed_supabase_config; the token is never read back out over the wire.
 *
 *   GET    → { configured, projectRef, lastPolledAt }   (no token returned)
 *   POST   { token, projectRef? } → stores it (encrypted)
 *   DELETE → clears it (poller goes back to a no-op)
 *
 * See docs/brain/integrations/supabase-management-logs.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isSupabaseLogPollConfigured,
  setSupabaseAccessToken,
  clearSupabaseAccessToken,
  getSupabaseLogConfig,
  projectRefFromEnv,
} from "@/lib/control-tower/supabase-log-poll";


type Admin = ReturnType<typeof createAdminClient>;

/** Shared owner gate — returns the admin client on success, or a NextResponse error. */
async function requireOwner(): Promise<{ admin: Admin } | { error: NextResponse }> {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can manage this" }, { status: 403 }) };
  }
  return { admin };
}

export async function GET() {
  const gate = await requireOwner();
  if ("error" in gate) return gate.error;
  const config = await getSupabaseLogConfig(gate.admin);
  return NextResponse.json({
    configured: await isSupabaseLogPollConfigured(gate.admin),
    projectRef: config?.projectRef ?? projectRefFromEnv(),
    lastPolledAt: config?.lastPolledAt ?? null,
  });
}

export async function POST(request: Request) {
  const gate = await requireOwner();
  if ("error" in gate) return gate.error;

  let body: { token?: unknown; projectRef?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; projectRef?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "A non-empty token is required" }, { status: 400 });
  const projectRef = typeof body.projectRef === "string" && body.projectRef.trim() ? body.projectRef.trim() : undefined;

  await setSupabaseAccessToken(token, { projectRef }, gate.admin);
  return NextResponse.json({ configured: true, projectRef: projectRef ?? projectRefFromEnv() });
}

export async function DELETE() {
  const gate = await requireOwner();
  if ("error" in gate) return gate.error;
  await clearSupabaseAccessToken(gate.admin);
  return NextResponse.json({ configured: false });
}
