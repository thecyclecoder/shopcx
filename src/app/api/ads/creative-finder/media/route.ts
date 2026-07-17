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
import sharp from "sharp";
import { getAuthedUser } from "@/lib/supabase/server";
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
  const { user } = await getAuthedUser();
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
    const { buffer } = await fetchCreative(u);
    // AdLibrary serves full-res source creatives (routinely 6-22MB) with an unreliable content-type
    // (reports jpeg for png bytes). A 22MB buffered response exceeds the serverless response-size limit
    // → the browser <img> breaks. Downscale + re-encode JPEG for display: correct content-type, small
    // body, crisp on the browse card. (Mirrors the vision-path normalize in creative-skeleton.ts.)
    let out = buffer;
    try {
      out = await sharp(buffer)
        .resize({ width: 1440, height: 1440, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch {
      // Non-image / undecodable bytes: fall back to streaming the original (best-effort).
    }
    return new NextResponse(new Uint8Array(out), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "fetch failed" }, { status: 502 });
  }
}
