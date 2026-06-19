/**
 * Winning Static-Creative Finder — authenticated creative proxy (internal analysis).
 *
 *   GET ?workspaceId=&u=<adlibrary creative url>
 *
 * AdLibrary creative urls 403 without the Bearer key, so the dashboard can't <img>
 * them directly. We proxy through here (workspace-member gated, host-allowlisted) so
 * the operator can SEE the winner being analyzed — we never re-host or republish the
 * asset, we stream it on demand for our own admin review. See the spec's safety
 * invariants. docs/brain/specs/winning-static-creative-finder.md.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCreative } from "@/lib/adlibrary";

function isAllowedHost(u: string): boolean {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host === "adlibrary.com" || host.endsWith(".adlibrary.com");
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const u = url.searchParams.get("u");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId || !u)
    return NextResponse.json({ error: "workspaceId and u required" }, { status: 400 });
  if (!isAllowedHost(u))
    return NextResponse.json({ error: "host not allowed" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const { buffer, contentType } = await fetchCreative(u);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "fetch failed" }, { status: 502 });
  }
}
