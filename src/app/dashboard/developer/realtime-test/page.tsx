"use client";

/**
 * /dashboard/developer/realtime-test — a live verification of Supabase Realtime (Postgres Changes).
 *
 * Proves the push pattern that replaces browser polling: this page opens ONE WebSocket, subscribes to
 * `public.realtime_demo`, and updates the moment a row changes — no `setInterval`, no repeated
 * PostgREST auth. Make a service-role write to a realtime_demo row (scripts/_bump-realtime-demo.ts)
 * and watch the table + event log update here with no refresh.
 *
 * Brain: docs/brain/tables/realtime_demo.md · docs/brain/recipes/realtime-subscriptions.md
 */

import RealtimeDemoPanel from "./RealtimeDemoPanel";

export default function RealtimeTestPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Realtime test</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Live Postgres → browser updates over one WebSocket subscription — no polling. A service-role
          write to a <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">realtime_demo</code> row
          appears below within a few hundred milliseconds.
        </p>
      </header>
      <RealtimeDemoPanel />
    </div>
  );
}
