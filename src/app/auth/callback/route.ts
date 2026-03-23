import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserWorkspaces, setActiveWorkspace, autoAcceptInvites } from "@/lib/workspace";
import { isAuthorizedUser } from "@/lib/access";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.redirect(`${origin}/login?error=no_user`);
  }

  // Gate: check if user is authorized
  const authorized = await isAuthorizedUser(user.email);
  if (!authorized) {
    return NextResponse.redirect(`${origin}/coming-soon`);
  }

  // Auto-accept any pending invites for this email
  await autoAcceptInvites(user.id, user.email);

  // Determine workspace routing
  const workspaces = await getUserWorkspaces(user.id);

  if (workspaces.length === 0) {
    return NextResponse.redirect(`${origin}/workspace/new`);
  }

  if (workspaces.length === 1) {
    await setActiveWorkspace(user.id, workspaces[0].id);
    return NextResponse.redirect(`${origin}/dashboard`);
  }

  return NextResponse.redirect(`${origin}/workspace/select`);
}
