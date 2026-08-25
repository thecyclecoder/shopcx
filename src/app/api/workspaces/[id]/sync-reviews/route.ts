/**
 * Manual "sync reviews from Klaviyo" trigger — **retired** (klaviyo-sunset, Phase A).
 *
 * The Klaviyo subscription is cancelled and `syncKlaviyoReviews` is a guarded
 * no-op, so firing the event would report "sync started" and then silently do
 * nothing. Returning 410 keeps the failure honest for any caller still holding
 * the URL. The dashboard's Sync button is gone; Phase B deletes this route.
 *
 * See `@/lib/klaviyo-retired` and [[../../../../../../docs/brain/dashboard/reviews]].
 */
import { NextResponse } from "next/server";
import { KLAVIYO_RETIRED_RESULT } from "@/lib/klaviyo-retired";

export async function POST() {
  return NextResponse.json(
    {
      error: "Klaviyo review sync is retired — reviews are no longer imported from Klaviyo.",
      ...KLAVIYO_RETIRED_RESULT,
    },
    { status: 410 },
  );
}
