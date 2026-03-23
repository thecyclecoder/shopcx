import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/login", "/auth/callback", "/privacy", "/terms", "/eula"];
const WORKSPACE_SETUP_ROUTES = ["/workspace/new", "/workspace/select"];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isPublicRoute = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const isWorkspaceSetup = WORKSPACE_SETUP_ROUTES.some((r) => pathname.startsWith(r));

  // Unauthenticated users -> login (unless public route)
  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Authenticated users on login -> redirect based on workspace
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // Authenticated users on protected routes need a workspace
  if (user && !isPublicRoute && !isWorkspaceSetup && !pathname.startsWith("/api")) {
    const workspaceId = request.cookies.get("workspace_id")?.value;
    if (!workspaceId) {
      const url = request.nextUrl.clone();
      url.pathname = "/workspace/select";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
