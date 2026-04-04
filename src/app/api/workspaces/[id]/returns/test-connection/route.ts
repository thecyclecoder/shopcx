import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEasyPostClient } from "@/lib/easypost";
import { encrypt } from "@/lib/crypto";
import crypto from "crypto";

const WEBHOOK_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai") + "/api/webhooks/easypost";

// POST — test EasyPost connection + auto-register webhook
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const client = await getEasyPostClient(workspaceId);

    // 1. Verify API key by creating a test address
    await client.Address.create({
      street1: "417 Montgomery Street",
      city: "San Francisco",
      state: "CA",
      zip: "94104",
      country: "US",
      verify: ["delivery"],
    });

    // 2. Auto-register webhook if not already registered
    let webhookRegistered = false;
    try {
      const existing = await client.Webhook.all({ page_size: 100 });
      const webhooks = (existing?.webhooks || existing || []) as { url: string; disabled_at: string | null }[];
      const alreadyRegistered = webhooks.some(
        (w) => w.url === WEBHOOK_URL && !w.disabled_at
      );

      if (!alreadyRegistered) {
        // Generate a webhook secret for HMAC verification
        const admin = createAdminClient();
        const { data: ws } = await admin.from("workspaces").select("easypost_webhook_secret").eq("id", workspaceId).single();
        let webhookSecret = ws?.easypost_webhook_secret;

        if (!webhookSecret) {
          webhookSecret = crypto.randomBytes(32).toString("hex");
          await admin.from("workspaces").update({
            easypost_webhook_secret: encrypt(webhookSecret),
          }).eq("id", workspaceId);
        }

        await client.Webhook.create({
          url: WEBHOOK_URL,
          webhook_secret: webhookSecret,
        });
        webhookRegistered = true;
      }
    } catch (webhookErr) {
      console.error("[test-connection] Webhook registration failed (non-fatal):", webhookErr);
    }

    return NextResponse.json({ ok: true, webhook_registered: webhookRegistered, webhook_url: WEBHOOK_URL });
  } catch (err) {
    console.error("[test-connection] EasyPost test failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 },
    );
  }
}
