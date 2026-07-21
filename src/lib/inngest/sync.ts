import { errText } from "@/lib/error-text";
/**
 * Force Inngest to (re-)register this app's served functions — the deploy-time re-sync
 * (control-tower-complete-coverage spec, Phase 2). PUTting the serve endpoint is Inngest's
 * documented "manual sync": it makes the SDK re-introspect src/lib/inngest/registered-functions.ts
 * and register any newly-added `createFunction` with Inngest Cloud.
 *
 * The control-tower-monitor cron sat "awaiting first run" for days because a deploy never
 * re-synced the app, so Inngest never invoked it. Run this on deploy (the box build worker
 * calls it on startup, which happens right after it self-updates to a new SHA) so a new cron
 * registers automatically instead of silently never firing.
 *
 * Best-effort: returns a result, never throws — a failed sync must not crash its caller.
 * See docs/brain/libraries/control-tower-self-audit.md.
 */

/** Default prod serve endpoint; override with INNGEST_SERVE_URL or the arg. */
const DEFAULT_SERVE_URL = "https://shopcx.ai/api/inngest";

export interface SyncResult {
  ok: boolean;
  status: number | null;
  url: string;
  detail: string;
}

export async function syncInngestRegistration(serveUrl?: string): Promise<SyncResult> {
  const url = serveUrl || process.env.INNGEST_SERVE_URL || DEFAULT_SERVE_URL;
  try {
    const res = await fetch(url, { method: "PUT" });
    return {
      ok: res.ok,
      status: res.status,
      url,
      detail: res.ok ? `Inngest sync ok (PUT ${url} → ${res.status})` : `Inngest sync PUT ${url} → ${res.status}`,
    };
  } catch (e) {
    return { ok: false, status: null, url, detail: `Inngest sync PUT ${url} failed: ${errText(e)}` };
  }
}
