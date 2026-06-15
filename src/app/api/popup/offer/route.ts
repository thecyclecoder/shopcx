/**
 * GET /api/popup/offer?workspace_id=…&product_id=…
 *
 * Returns the computed stacked signup offer for a product (the same
 * value the smart popup shows), without making/logging a popup decision.
 * Read-only. Used by the survey chapter to render the value stack.
 * Returns {} when the product has no pricing tiers.
 */
import { NextResponse, type NextRequest } from "next/server";
import { computePopupOffer } from "@/lib/popup/offer";

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspace_id") || "";
  const productId = request.nextUrl.searchParams.get("product_id") || "";
  if (!workspaceId || !productId) return NextResponse.json({});
  try {
    const offer = await computePopupOffer(workspaceId, productId);
    return NextResponse.json(offer || {});
  } catch {
    return NextResponse.json({});
  }
}
