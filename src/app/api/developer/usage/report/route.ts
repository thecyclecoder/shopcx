/**
 * POST /api/developer/usage/report — Mac reporter ingest for the
 * fleet-usage-cockpit (Phase 2 of docs/brain/specs/fleet-usage-cockpit.md).
 *
 * The founder's Mac runs `scripts/usage-report.ts` on a launchd timer + a
 * SessionEnd hook (see docs/brain/recipes/mac-usage-reporter.md). Each run
 * shells out to `npx ccusage@latest blocks --json` for BOTH ~/.claude and
 * the ccusage Codex source (~/.codex/sessions), maps each output to
 * per-account snapshot payloads, and POSTs the batch here. The route
 * upserts them into account_usage_snapshots with source='mac' — same unique
 * key (workspace_id, source, account, window_kind) as the box writer, so a
 * re-report REPLACES the prior mac slice instead of duplicating.
 *
 * Auth: bearer token — Authorization: Bearer $DEVELOPER_USAGE_INGEST_TOKEN.
 * The founder has the token in .env.local on the Mac; the server holds the
 * same value in its process env. There is no user session on the Mac side,
 * so the developer-surface cookie flow (used by /api/developer/pulse) does
 * not apply — the pre-shared token IS the "owner auth" for the reporter.
 * A missing / empty header → 401; a mismatch → 403. Constant-time compare
 * so a length or content diff never leaks via timing.
 *
 * A malformed / missing-field payload → 400 (never a 500). See
 * validateMacReportPayload in src/lib/usage-snapshots.ts.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateMacReportPayload, upsertMacSnapshots } from "@/lib/usage-snapshots";
import { timingSafeEqual } from "crypto";

/** Constant-time bearer-token check. Missing / empty header → 401.
 * Mismatch → 403. A server missing the env var → 401 so a Mac probe with a
 * placeholder token surfaces as "not configured" rather than a 500. */
function checkOwnerToken(request: Request): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  const expected = process.env.DEVELOPER_USAGE_INGEST_TOKEN;
  const header = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "Missing Bearer token" };
  }
  const token = header.slice(7).trim();
  if (!expected) {
    return { ok: false, status: 401, error: "Usage-report ingest is not configured on this deployment" };
  }
  if (!token) return { ok: false, status: 401, error: "Empty Bearer token" };
  // constant-time compare — must be equal-length buffers, so hash both sides
  // by padding to the LONGER of the two. A length diff is itself the 403.
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, status: 403, error: "Invalid token" };
  if (!timingSafeEqual(a, b)) return { ok: false, status: 403, error: "Invalid token" };
  return { ok: true };
}

export async function POST(request: Request) {
  const gate = checkOwnerToken(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const parsed = validateMacReportPayload(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const admin = createAdminClient();
  try {
    const upserted = await upsertMacSnapshots(admin, parsed.payload);
    return NextResponse.json({ upserted });
  } catch (err) {
    console.error("[usage-report] upsert failed:", err);
    return NextResponse.json({ error: "Upsert failed" }, { status: 500 });
  }
}
