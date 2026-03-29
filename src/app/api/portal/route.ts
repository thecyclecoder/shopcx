// Main portal route handler — replaces standalone subscriptions-portal backend
// All requests: GET/POST /api/portal?route={routeName}
// Auth: Shopify App Proxy HMAC-SHA256 verification

import { NextRequest, NextResponse } from "next/server";
import { requireAppProxy } from "@/lib/portal/auth";
import { routeMap } from "@/lib/portal/handlers";

function jsonErr(body: Record<string, unknown>, status = 400) {
  return NextResponse.json({ ok: false, ...body }, { status });
}

async function handle(req: NextRequest) {
  try {
    const auth = await requireAppProxy(req);
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
