import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEasyPostClient } from "@/lib/easypost";
import { encrypt } from "@/lib/crypto";
import crypto from "crypto";

const WEBHOOK_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai") + "/api/webhooks/easypost";

/** Register webhook for a specific EasyPost client if not already registered */
async function ensureWebhook(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  webhookSecret: string,
): Promise<boolean> {
  try {
    const existing = await client.Webhook.all({ page_size: 100 });
    const webhooks = (existing?.webhooks || existing || []) as { url: string; disabled_at: string | null }[];
    const alreadyRegistered = webhooks.some(
      (w) => w.url === WEBHOOK_URL && !w.disabled_at,
    );

    if (!alreadyRegistered) {
      await client.Webhook.create({
        url: WEBHOOK_URL,
        webhook_secret: webhookSecret,
      });
      return true;
    }
    return false;
  } catch (err) {
    console.error("[test-connection] Webhook registration failed (non-fatal):", err);
    return false;
  }
}

// POST — test EasyPost connection + auto-register webhooks for both test & live keys
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
    // Ensure we have a webhook secret
    const admin = createAdminClient();
    const { data: ws } = await admin
      .from("workspaces")
      .select("easypost_webhook_secret, easypost_test_api_key_encrypted, easypost_live_api_key_encrypted")
      .eq("id", workspaceId)
      .single();

    let webhookSecret = ws?.easypost_webhook_secret;
    if (!webhookSecret) {
      webhookSecret = crypto.randomBytes(32).toString("hex");
      await admin
        .from("workspaces")
        .update({ easypost_webhook_secret: encrypt(webhookSecret) })
        .eq("id", workspaceId);
    }

    const results: { test?: string; live?: string } = {};

    // Test the test key + register webhook
    if (ws?.easypost_test_api_key_encrypted) {
      try {
        const testClient = await getEasyPostClient(workspaceId, "test");
        await testClient.Address.create({
          street1: "417 Montgomery Street",
          city: "San Francisco",
          state: "CA",
          zip: "94104",
          country: "US",
          verify: ["delivery"],
        });
        const registered = await ensureWebhook(testClient, webhookSecret);
        results.test = registered ? "connected_webhook_registered" : "connected";
      } catch (err) {
        results.test = `error: ${err instanceof Error ? err.message : "Connection failed"}`;
      }
    }

    // Test the live key + register webhook
    if (ws?.easypost_live_api_key_encrypted) {
      try {
        const liveClient = await getEasyPostClient(workspaceId, "live");
        await liveClient.Address.create({
          street1: "417 Montgomery Street",
          city: "San Francisco",
          state: "CA",
          zip: "94104",
          country: "US",
          verify: ["delivery"],
        });
        const registered = await ensureWebhook(liveClient, webhookSecret);
        results.live = registered ? "connected_webhook_registered" : "connected";
      } catch (err) {
        results.live = `error: ${err instanceof Error ? err.message : "Connection failed"}`;
      }
    }

    if (!results.test && !results.live) {
      return NextResponse.json({ error: "No API keys configured" }, { status: 400 });
    }

    const anyError = (results.test?.startsWith("error") && !results.live?.startsWith("connected"))
      || (results.live?.startsWith("error") && !results.test?.startsWith("connected"));

    return NextResponse.json({
      ok: !anyError,
      results,
      webhook_url: WEBHOOK_URL,
    });
  } catch (err) {
    console.error("[test-connection] EasyPost test failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 },
    );
  }
}
