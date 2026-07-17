import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";
import { probeGeminiAuth } from "@/lib/gemini";

async function authorize(workspaceId: string) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
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

// Status: is a Google AI Studio key stored, and a hint of it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth.error) return auth.error;
  const { data: ws } = await auth.admin
    .from("workspaces")
    .select("gemini_api_key_encrypted, gemini_project_id")
    .eq("id", id)
    .single();
  const enc = ws?.gemini_api_key_encrypted as string | null;
  return NextResponse.json({
    connected: !!enc,
    hint: enc ? `…${decrypt(enc).slice(-4)}` : null,
    project_id: ws?.gemini_project_id ?? null,
  });
}

// Save the key (+ optional project id), encrypted, then verify it.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth.error) return auth.error;
  const body = await req.json().catch(() => ({}));
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : null;

  const update: Record<string, unknown> = {};
  if (apiKey) update.gemini_api_key_encrypted = encrypt(apiKey);
  if (projectId !== null) update.gemini_project_id = projectId || null;
  if (!Object.keys(update).length) return NextResponse.json({ error: "no_fields" }, { status: 400 });

  const { error } = await auth.admin.from("workspaces").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const probe = await probeGeminiAuth(id);
  return NextResponse.json({ ok: true, verified: probe.ok, status: probe.status });
}

// Verify the currently-stored key without changing it.
export async function PATCH(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth.error) return auth.error;
  const probe = await probeGeminiAuth(id);
  return NextResponse.json({ verified: probe.ok, status: probe.status });
}
