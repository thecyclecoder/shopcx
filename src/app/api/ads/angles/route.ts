import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateAngles } from "@/lib/ad-angles";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId)
    return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const productId = url.searchParams.get("productId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;
  if (!productId)
    return NextResponse.json({ error: "productId required" }, { status: 400 });

  const { data, error } = await auth.admin
    .from("product_ad_angles")
    .select("*")
    .eq("workspace_id", workspaceId as string)
    .eq("product_id", productId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

export async function POST(req: Request) {
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const productId: string | undefined = body.productId;
  if (!productId)
    return NextResponse.json({ error: "productId required" }, { status: 400 });

  const count: number = typeof body.count === "number" ? body.count : 12;
  const result = await generateAngles(productId, count);

  if (!result.ok)
    return NextResponse.json(
      { ok: false, reason: result.reason || "generate_failed" },
      { status: 502 },
    );

  return NextResponse.json({
    ok: true,
    inserted: result.inserted.length,
    rejected: result.rejected.length,
  });
}
