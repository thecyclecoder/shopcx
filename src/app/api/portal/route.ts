// Main portal route handler — replaces standalone subscriptions-portal backend
// All requests: GET/POST /api/portal?route={routeName}
// Auth: Shopify App Proxy HMAC-SHA256 (Shopify extension) OR encrypted cookie session (mini-site)

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireAppProxy, type PortalAuthResult } from "@/lib/portal/auth";
import { routeMap } from "@/lib/portal/handlers";
import { decrypt } from "@/lib/crypto";

function jsonErr(body: Record<string, unknown>, status = 400) {
  return NextResponse.json({ ok: false, ...body }, { status });
}

async function resolveAuth(req: NextRequest): Promise<PortalAuthResult> {
  // Try HMAC auth first (Shopify App Proxy)
  const url = new URL(req.url);
  if (url.searchParams.has("signature")) {
    return requireAppProxy(req);
  }

  // Fall back to cookie session (mini-site portal)
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("portal_session")?.value;
  if (!sessionCookie) throw new Error("No portal session");

  let session: { shopify_customer_id: string; workspace_id: string; exp: number };
  try {
    session = JSON.parse(decrypt(sessionCookie));
  } catch {
    throw new Error("Invalid portal session");
  }

  if (!session || Date.now() > session.exp) throw new Error("Portal session expired");

  return {
    shop: "",
    loggedInCustomerId: session.shopify_customer_id,
    workspaceId: session.workspace_id,
  };
}

async function handle(req: NextRequest) {
  try {
    const auth = await resolveAuth(req);
    const url = new URL(req.url);

    const route = (url.searchParams.get("route") || "bootstrap").toLowerCase();
    const handler = routeMap[route];

    if (!handler) {
      return jsonErr({ error: "unknown_route", route }, 400);
    }

    return await handler({ req, url, auth, route });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unauthorized";

    if (message === "APP_PROXY_INVALID_SIGNATURE") {
      return jsonErr({ error: "unauthorized", message: "Invalid signature" }, 401);
    }

    console.error("[portal] route error:", message);
    return jsonErr({ error: "unauthorized", message }, 401);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

// Support HEAD for health checks
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
