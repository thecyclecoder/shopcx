import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { signLanderShot } from "@/lib/landing-page-scout";

// Landing Page Scout owner surface (docs/brain/specs/landing-page-scout.md, Phase 1).
//   GET  ?workspaceId=&productId=  → list lander snapshots (competitor + ours), with signed chapter URLs
//   POST { workspaceId, productId? }  → fire the vision gap-analysis over already-captured snapshots
// The mobile per-chapter CAPTURE itself runs on the box (scripts/landing-page-snapshot.ts). Owner/admin only.

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

interface ChapterShot {
  index?: number;
  label?: string;
  screenshot_path?: string;
  avg_dwell_ms?: number;
  view_to_cta_pct?: number;
  reach_sessions?: number;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const productId = url.searchParams.get("productId");

  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  let q = auth.admin
    .from("lander_snapshots")
    .select("id, product_id, competitor_id, is_ours, brand, url, source, status, chapters, error, captured_at, created_at")
    .eq("workspace_id", workspaceId as string)
    .order("created_at", { ascending: false })
    .limit(200);
  if (productId) q = q.eq("product_id", productId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Sign each chapter screenshot for preview (short-lived).
  const snapshots = await Promise.all(
    (data ?? []).map(async (s) => {
      const chapters = ((s.chapters as ChapterShot[]) || []);
      const signed = await Promise.all(
        chapters.map(async (ch) => ({
          ...ch,
          signed_url: ch.screenshot_path ? await signLanderShot(ch.screenshot_path) : null,
        })),
      );
      return { ...s, chapters: signed };
    }),
  );

  return NextResponse.json({ snapshots });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const productId: string | null = body.productId ?? null;

  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  // Vision gap-analysis is an LLM pass — run it async (it spends tokens + can take a while).
  await inngest
    .send({ name: "ads/landing-page-scout.analyze", data: { workspaceId, productId } })
    .catch(() => {});

  return NextResponse.json({ ok: true, dispatched: { workspaceId, productId } });
}
