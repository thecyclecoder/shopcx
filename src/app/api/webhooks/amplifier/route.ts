import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { inngest } from "@/lib/inngest/client";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  let body: {
    id: string;
    type: string;
    timestamp: string;
    data: {
      id: string;
      reference_id?: string;
      order_source?: string;
      method?: string;
      tracking_number?: string;
      date?: string;
      items?: { sku: string; description: string; quantity: number }[];
    };
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, data } = body;

  if (!type || !data?.id) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Fast token validation — find workspace
  const admin = createAdminClient();
  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, amplifier_webhook_token_encrypted")
    .not("amplifier_webhook_token_encrypted", "is", null);

  let workspaceId: string | null = null;
  for (const ws of workspaces || []) {
    try {
      const decrypted = decrypt(ws.amplifier_webhook_token_encrypted);
      if (decrypted === token) {
        workspaceId = ws.id;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!workspaceId) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  // Queue to Inngest for async processing — return 200 immediately
  await inngest.send({
    name: "amplifier/webhook-received",
    data: {
      workspaceId,
      type: body.type,
      data: body.data,
      timestamp: body.timestamp,
    },
  });

  return NextResponse.json({ ok: true, queued: true });
}
