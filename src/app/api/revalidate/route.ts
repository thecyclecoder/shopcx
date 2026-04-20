import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

/**
 * On-demand ISR revalidation endpoint. Called when content is edited
 * in the dashboard (publish / pricing update / review sync).
 *
 * Request:
 *   POST /api/revalidate
 *   { path: "/store/superfoods/amazing-coffee", secret: "…" }
 */
export async function POST(request: Request) {
  let body: { path?: string; secret?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const expected = process.env.REVALIDATION_SECRET;
  if (!expected || body.secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = typeof body.path === "string" ? body.path : "";
  if (!path || !path.startsWith("/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    revalidatePath(path);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Revalidation failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ revalidated: true, path });
}
