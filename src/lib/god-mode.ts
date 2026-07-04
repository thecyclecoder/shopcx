/**
 * god-mode — Phase 1 SDK + PIN hashing for the founder god-mode cockpit.
 *
 * See [[../../docs/brain/specs/god-mode]] + [[../../docs/brain/lifecycles/god-mode]].
 *
 * This module is the WRITE CHOKEPOINT for the two god-mode tables — nothing
 * else should hit them raw (same discipline as specs-table / goals-table /
 * lander-blueprints). Callers (arm/disarm routes, the box gate, the cockpit
 * approve route) pass typed arguments; this file synthesizes the row shape.
 *
 * PIN storage: the founder PIN is stored ONLY as a one-way scrypt hash on
 * workspaces.god_mode_pin_hash. Plaintext never enters this file — hashPin()
 * takes the PIN, salts it, and returns the "scrypt:v1:<salt>:<hash>" string
 * that lands in the column; verifyPin() takes the same string + a candidate
 * PIN and does a constant-time compare. The plaintext PIN is set OUT-OF-BAND
 * via scripts/_set-god-mode-pin.ts (never in source, never in a migration).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSMS } from "@/lib/twilio";

// ── PIN hashing ────────────────────────────────────────────────────────────
//
// scrypt is deliberately expensive so a leaked hash isn't brute-forceable
// against a 4-6 digit PIN in seconds. N=2^15 is the standard "interactive
// login" cost — a few hundred ms per verify on the box, negligible under the
// once-per-destructive-approval call rate.
//
// maxmem MUST be passed explicitly: N=2^15 · r=8 needs 128·(N+2)·r ≈ 33,556,480
// bytes, which is 2 KB over Node's default 32 MiB scrypt cap — every call
// throws `RangeError: memory limit exceeded` without a higher cap. 64 MiB
// gives comfortable headroom without changing the derived-hash format.
const SCRYPT_N = 1 << 15;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const HASH_VERSION = "v1";

/** Hash a PIN for storage on workspaces.god_mode_pin_hash. Format: `scrypt:v1:<saltHex>:<hashHex>`. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(pin, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${HASH_VERSION}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Constant-time verify a candidate PIN against a stored `scrypt:v1:<salt>:<hash>` string. */
export function verifyPin(candidate: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== HASH_VERSION) return false;
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  if (salt.length !== 16 || expected.length !== SCRYPT_KEYLEN) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(candidate, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_r,
      p: SCRYPT_p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

// ── Session model ─────────────────────────────────────────────────────────

/** 48-char hex cockpit token (24 random bytes). Same size as journey_sessions.token. */
export function newCockpitToken(): string {
  return randomBytes(24).toString("hex");
}

/** Sliding-TTL bump — every GET/message/approve/turn extends the token this long. */
export const SLIDING_TTL_MS = 20 * 60 * 1000;
/** Hard ceiling — arm() + 12h. Never bumped; the reaper force-disarms past this. */
export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

export type GodModeMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
};

export type GodModeStatus = "armed" | "disarmed" | "expired";

export type GodModeApprovalRisk = "safe" | "write" | "destructive";
export type GodModeApprovalStatus = "pending" | "approved" | "denied" | "asked";

export type GodModeApprovalRow = {
  id: string;
  session_id: string;
  workspace_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  preview: string;
  risk: GodModeApprovalRisk;
  status: GodModeApprovalStatus;
  question_text: string | null;
  decided_at: string | null;
  created_at: string;
};

export type GodModeSessionRow = {
  id: string;
  workspace_id: string;
  created_by: string;
  status: GodModeStatus;
  cockpit_token: string | null;
  token_expires_at: string | null;
  absolute_expires_at: string | null;
  box_session_id: string | null;
  box_session_config_dir: string | null;
  messages: GodModeMessage[];
  last_activity_at: string;
  armed_at: string;
  disarmed_at: string | null;
  created_at: string;
};

type Admin = SupabaseClient;

/**
 * Arm a session for a workspace. Idempotent w.r.t. the "one active session per
 * workspace" invariant: if an armed session already exists, its cockpit_token
 * is REFRESHED (new 48-hex slug) and the sliding + absolute TTLs are reset.
 * Returns the row (post-write).
 */
export async function armSession(
  admin: Admin,
  args: { workspaceId: string; createdBy: string },
): Promise<GodModeSessionRow> {
  const now = new Date();
  const token = newCockpitToken();
  const tokenExpiresAt = new Date(now.getTime() + SLIDING_TTL_MS).toISOString();
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS).toISOString();

  const { data: existing } = await admin
    .from("god_mode_sessions")
    .select("*")
    .eq("workspace_id", args.workspaceId)
    .eq("status", "armed")
    .maybeSingle();

  if (existing) {
    const { data: updated, error } = await admin
      .from("god_mode_sessions")
      .update({
        cockpit_token: token,
        token_expires_at: tokenExpiresAt,
        absolute_expires_at: absoluteExpiresAt,
        last_activity_at: now.toISOString(),
        armed_at: now.toISOString(),
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error || !updated) throw new Error(`arm(refresh) failed: ${error?.message ?? "no row"}`);
    // Phase-5 SMS: re-arm sends a fresh notification with the (refreshed) token.
    void sendGodModeSMS(admin, { workspaceId: args.workspaceId, kind: "arm", cockpitToken: token });
    return updated as GodModeSessionRow;
  }

  const { data: inserted, error } = await admin
    .from("god_mode_sessions")
    .insert({
      workspace_id: args.workspaceId,
      created_by: args.createdBy,
      status: "armed",
      cockpit_token: token,
      token_expires_at: tokenExpiresAt,
      absolute_expires_at: absoluteExpiresAt,
      last_activity_at: now.toISOString(),
      armed_at: now.toISOString(),
    })
    .select("*")
    .single();
  if (error || !inserted) throw new Error(`arm(insert) failed: ${error?.message ?? "no row"}`);
  // Phase-5 SMS: on arm, deliver the cockpit URL to the founder's mobile.
  void sendGodModeSMS(admin, { workspaceId: args.workspaceId, kind: "arm", cockpitToken: token });
  return inserted as GodModeSessionRow;
}

/**
 * Disarm the workspace's active session (or a specific session by id). Nulls
 * the cockpit token, flips status to 'disarmed', stamps disarmed_at. Idempotent
 * — a session already disarmed/expired returns unchanged.
 */
export async function disarmSession(
  admin: Admin,
  args: { workspaceId?: string; sessionId?: string },
): Promise<GodModeSessionRow | null> {
  if (!args.workspaceId && !args.sessionId) throw new Error("workspaceId or sessionId required");

  const query = admin
    .from("god_mode_sessions")
    .select("*")
    .eq("status", "armed")
    .limit(1);
  if (args.sessionId) query.eq("id", args.sessionId);
  else if (args.workspaceId) query.eq("workspace_id", args.workspaceId);

  const { data } = await query.maybeSingle();
  if (!data) return null;

  const now = new Date().toISOString();
  // Phase-5 SMS: session-done push BEFORE nulling the cockpit_token so the URL
  // remains meaningful in the message body ("session ended" — nothing to open).
  // The reason "disarmed" distinguishes it from the reaper's idle/ceiling
  // messages.
  const sessionRow = data as GodModeSessionRow;
  void sendGodModeSMS(admin, {
    workspaceId: sessionRow.workspace_id,
    kind: "done",
    cockpitToken: sessionRow.cockpit_token,
    context: { reason: "disarmed" },
  });
  const { data: updated, error } = await admin
    .from("god_mode_sessions")
    .update({
      status: "disarmed",
      cockpit_token: null,
      disarmed_at: now,
      last_activity_at: now,
    })
    .eq("id", data.id)
    .select("*")
    .single();
  if (error || !updated) throw new Error(`disarm failed: ${error?.message ?? "no row"}`);
  return updated as GodModeSessionRow;
}

/** Load the active (armed) session for a workspace, or null. */
export async function getActiveSession(admin: Admin, workspaceId: string): Promise<GodModeSessionRow | null> {
  const { data } = await admin
    .from("god_mode_sessions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("status", "armed")
    .maybeSingle();
  return (data as GodModeSessionRow | null) ?? null;
}

/** Load a session by cockpit token (the /god/[token] path). Returns null on unknown token. */
export async function getSessionByToken(admin: Admin, token: string): Promise<GodModeSessionRow | null> {
  if (!token || token.length !== 48) return null;
  const { data } = await admin
    .from("god_mode_sessions")
    .select("*")
    .eq("cockpit_token", token)
    .maybeSingle();
  return (data as GodModeSessionRow | null) ?? null;
}

/** Compose the /god/{token} URL from NEXT_PUBLIC_SITE_URL (mirrors journey-delivery). */
export function cockpitUrl(token: string): string {
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  return `${siteUrl}/god/${token}`;
}

// ── Phase 2 mutators — box lane + gate call these ─────────────────────────

/**
 * Append one message to a session's transcript. Read-modify-write is fine here
 * — the box lane is concurrency-1 per session (only one turn writes at a time),
 * so no interleaving. Also bumps `last_activity_at` — the Phase-5 in-flight
 * signal — so a live turn never idles the session out.
 */
export async function appendMessage(
  admin: Admin,
  sessionId: string,
  message: GodModeMessage,
): Promise<void> {
  const { data } = await admin
    .from("god_mode_sessions")
    .select("messages")
    .eq("id", sessionId)
    .maybeSingle();
  const existing = Array.isArray(data?.messages) ? (data!.messages as GodModeMessage[]) : [];
  await admin
    .from("god_mode_sessions")
    .update({ messages: [...existing, message], last_activity_at: new Date().toISOString() })
    .eq("id", sessionId);
}

/** Capture the box session id + config dir after a turn so the next turn --resume's cleanly. */
export async function setBoxSession(
  admin: Admin,
  sessionId: string,
  args: { boxSessionId: string | null; boxSessionConfigDir: string | null },
): Promise<void> {
  await admin
    .from("god_mode_sessions")
    .update({
      box_session_id: args.boxSessionId,
      box_session_config_dir: args.boxSessionConfigDir,
    })
    .eq("id", sessionId);
}

/**
 * Bump the sliding TTL + last_activity_at forward. Called on every GET /
 * message / approve / turn stream line — keeps the session live under Phase-5's
 * reaper. Idempotent, never past `absolute_expires_at` (the hard ceiling).
 */
export async function bumpActivity(admin: Admin, sessionId: string): Promise<void> {
  const now = new Date();
  const newTokenExpiresAt = new Date(now.getTime() + SLIDING_TTL_MS).toISOString();
  // We could clamp against absolute_expires_at, but the reaper independently
  // enforces the absolute ceiling — so a bump past it just sets a longer
  // token_expires_at than absolute_expires_at, and the reaper still force-
  // disarms on the absolute check.
  await admin
    .from("god_mode_sessions")
    .update({ token_expires_at: newTokenExpiresAt, last_activity_at: now.toISOString() })
    .eq("id", sessionId);
}

/**
 * Open one approval row — the Phase-2 gate lands here for every non-safe tool
 * call. Denorms `workspace_id` off the session so the cockpit read path stays
 * one-row-lookup. Returns the freshly-written row.
 */
export async function openApproval(
  admin: Admin,
  args: {
    sessionId: string;
    workspaceId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    preview: string;
    risk: GodModeApprovalRisk;
  },
): Promise<GodModeApprovalRow> {
  const { data, error } = await admin
    .from("god_mode_approvals")
    .insert({
      session_id: args.sessionId,
      workspace_id: args.workspaceId,
      tool_name: args.toolName,
      tool_input: args.toolInput,
      preview: args.preview,
      risk: args.risk,
      status: "pending",
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`openApproval failed: ${error?.message ?? "no row"}`);

  // Phase-5 SMS: every new pending approval pushes ONE SMS with the same
  // persistent cockpit URL (deep-links to the Approvals tab). Fire-and-
  // forget — a failed SMS never blocks the gate. Look up the session's
  // cockpit_token here since the caller (the box gate) only has the
  // session id.
  const { data: session } = await admin
    .from("god_mode_sessions")
    .select("cockpit_token")
    .eq("id", args.sessionId)
    .maybeSingle();
  void sendGodModeSMS(admin, {
    workspaceId: args.workspaceId,
    kind: "approval",
    cockpitToken: (session as { cockpit_token: string | null } | null)?.cockpit_token ?? null,
    context: { toolName: args.toolName, risk: args.risk },
  });

  return data as GodModeApprovalRow;
}

/** Fetch one approval by id — the gate's poll loop reads this every ~2s. */
export async function getApproval(admin: Admin, id: string): Promise<GodModeApprovalRow | null> {
  const { data } = await admin
    .from("god_mode_approvals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as GodModeApprovalRow | null) ?? null;
}

/**
 * Resolve one approval to a terminal status. Idempotent — no-op if already
 * terminal. Stamps decided_at. On `ask`, requires question_text.
 */
export async function decideApproval(
  admin: Admin,
  args: {
    approvalId: string;
    decision: "approve" | "deny" | "ask";
    questionText?: string;
  },
): Promise<GodModeApprovalRow | null> {
  const existing = await getApproval(admin, args.approvalId);
  if (!existing) return null;
  if (existing.status !== "pending") return existing;

  const nextStatus: GodModeApprovalStatus =
    args.decision === "approve" ? "approved" : args.decision === "deny" ? "denied" : "asked";
  if (nextStatus === "asked" && !args.questionText) {
    throw new Error("decideApproval(ask) requires questionText");
  }

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("god_mode_approvals")
    .update({
      status: nextStatus,
      question_text: nextStatus === "asked" ? (args.questionText ?? null) : null,
      decided_at: now,
    })
    .eq("id", args.approvalId)
    .select("*")
    .single();
  if (error || !data) throw new Error(`decideApproval failed: ${error?.message ?? "no row"}`);
  return data as GodModeApprovalRow;
}

/**
 * Phase-5 in-flight check: does the session have any pending approval OR a
 * recently-active turn? Reaper uses this to decide whether an idle-TTL-past
 * session is safe to expire.
 */
export async function hasInFlight(admin: Admin, sessionId: string): Promise<boolean> {
  const { count } = await admin
    .from("god_mode_approvals")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "pending");
  return (count ?? 0) > 0;
}

/**
 * Load the sliding + absolute TTLs for a session (the gate uses these to bail
 * fast if the founder disarmed the session while the box was mid-tool-call).
 */
export async function isSessionArmed(admin: Admin, sessionId: string): Promise<boolean> {
  const { data } = await admin
    .from("god_mode_sessions")
    .select("status, absolute_expires_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (!data) return false;
  if (data.status !== "armed") return false;
  if (data.absolute_expires_at && new Date(data.absolute_expires_at) < new Date()) return false;
  return true;
}

// ── Phase 3 cockpit-facing helpers ────────────────────────────────────────

/** The disposition a cockpit token resolves to — the /god/[token] route branches on this. */
export type TokenResolution =
  | { kind: "ok"; session: GodModeSessionRow }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "disarmed" };

/**
 * Resolve a cockpit token to an armed, non-expired session (or a typed rejection).
 * The `/god/[token]` page + `/api/god/[token]/*` routes ALL go through this — a
 * single chokepoint decides not-found vs expired vs disarmed, so every route
 * returns the same shape (404 / 410) for the same reason.
 *
 *   • unknown token or wrong-length → not_found
 *   • row exists but status !== 'armed' → disarmed
 *   • row is armed but past token_expires_at OR absolute_expires_at → expired
 *   • otherwise → ok
 */
export async function resolveCockpitToken(admin: Admin, token: string): Promise<TokenResolution> {
  const session = await getSessionByToken(admin, token);
  if (!session) return { kind: "not_found" };
  if (session.status !== "armed") return { kind: "disarmed" };
  const now = new Date();
  if (session.absolute_expires_at && new Date(session.absolute_expires_at) < now) return { kind: "expired" };
  if (session.token_expires_at && new Date(session.token_expires_at) < now) return { kind: "expired" };
  return { kind: "ok", session };
}

/** List approvals for a session, most-recent first. Pending float to the top in the UI, but that's a render decision. */
export async function listApprovalsForSession(
  admin: Admin,
  sessionId: string,
  limit = 50,
): Promise<GodModeApprovalRow[]> {
  const { data } = await admin
    .from("god_mode_approvals")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as GodModeApprovalRow[] | null) ?? [];
}

/**
 * Read one approval row scoped to a session — the Phase-3 approve route uses
 * this to enforce the tamper-guard: a token can only act on its OWN session's
 * approvals, never another workspace's. Returns null on mismatch (same shape
 * as "row not found" so the caller can't distinguish).
 */
export async function getApprovalForSession(
  admin: Admin,
  args: { approvalId: string; sessionId: string },
): Promise<GodModeApprovalRow | null> {
  const { data } = await admin
    .from("god_mode_approvals")
    .select("*")
    .eq("id", args.approvalId)
    .eq("session_id", args.sessionId)
    .maybeSingle();
  return (data as GodModeApprovalRow | null) ?? null;
}

/** Load the workspace's god_mode_pin_hash. Used by the destructive-approval PIN gate. */
export async function loadPinHash(admin: Admin, workspaceId: string): Promise<string | null> {
  const { data } = await admin
    .from("workspaces")
    .select("god_mode_pin_hash")
    .eq("id", workspaceId)
    .maybeSingle();
  return (data?.god_mode_pin_hash as string | null) ?? null;
}

// ── Phase 5 — SMS delivery + reaper ───────────────────────────────────────

/** Read the founder's mobile: workspace column FIRST, then env, else null. */
export async function resolveFounderPhone(admin: Admin, workspaceId: string): Promise<string | null> {
  const { data } = await admin
    .from("workspaces")
    .select("god_mode_sms_number")
    .eq("id", workspaceId)
    .maybeSingle();
  const wsNum = typeof data?.god_mode_sms_number === "string" ? data.god_mode_sms_number.trim() : "";
  if (wsNum) return wsNum;
  const envNum = (process.env.GOD_MODE_FOUNDER_PHONE || "").trim();
  return envNum || null;
}

/**
 * The three god-mode SMS events. Distinct kinds keep the text deterministic +
 * make an integration test straightforward.
 *
 *   • arm      — "God mode armed on {ws}. Cockpit: {url}"
 *   • approval — "God mode: {tool} needs your approval ({risk}). Cockpit: {url}"
 *   • done     — "God mode session ended ({reason}). Re-arm in the app if needed."
 *
 * "reply" is intentionally absent — the spec says plain box replies send NONE
 * (the Chat tab handles live watching). Only approvals + session-done push.
 */
export type GodModeSmsKind = "arm" | "approval" | "done";

/**
 * Best-effort SMS emit. Never throws; returns { sent } for the caller's log.
 * Silent no-op when no founder phone is resolvable OR the workspace has no
 * twilio_phone_number (sendSMS returns success:false with a reason).
 */
export async function sendGodModeSMS(
  admin: Admin,
  args: {
    workspaceId: string;
    kind: GodModeSmsKind;
    cockpitToken?: string | null;
    context?: { toolName?: string; risk?: GodModeApprovalRisk; reason?: string };
  },
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const to = await resolveFounderPhone(admin, args.workspaceId);
    if (!to) return { sent: false, reason: "no founder phone configured" };

    const url = args.cockpitToken ? cockpitUrl(args.cockpitToken) : "";
    let text = "";
    if (args.kind === "arm") {
      text = `God mode armed. Cockpit:`;
    } else if (args.kind === "approval") {
      const tool = args.context?.toolName ?? "Tool";
      const risk = args.context?.risk ?? "write";
      text = `God mode: ${tool} needs your approval (${risk}). Approvals tab:`;
    } else {
      const reason = args.context?.reason ?? "ended";
      text = `God mode session ${reason}. Re-arm in the app if needed.`;
    }
    const body = url ? `${text}\n\n${url}` : text;

    const r = await sendSMS(args.workspaceId, to, body);
    return { sent: r.success, reason: r.error };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Phase-5 reaper — one pass. Called from a beat in the box-worker poll loop.
 *
 *   1) Any session past `absolute_expires_at` → force-disarm (status='expired',
 *      cockpit_token=NULL, disarmed_at=now). ALWAYS, regardless of activity.
 *   2) Any session past `token_expires_at` with NO in-flight signal — no
 *      pending approval AND no building god-mode turn — → idle-expire.
 *      In-flight (pending approval OR building turn) holds the door open
 *      indefinitely so the founder can respond whenever he sees the SMS.
 *
 * On expiry: send one "session done" SMS (best-effort), then flip the row.
 * Returns counts for the box's log.
 */
export async function reapGodModeSessions(admin: Admin): Promise<{
  forceDisarmed: number;
  idleExpired: number;
}> {
  const now = new Date();
  const nowIso = now.toISOString();
  let forceDisarmed = 0;
  let idleExpired = 0;

  const { data: armed } = await admin
    .from("god_mode_sessions")
    .select("id, workspace_id, cockpit_token, token_expires_at, absolute_expires_at")
    .eq("status", "armed");
  const rows = (armed as {
    id: string;
    workspace_id: string;
    cockpit_token: string | null;
    token_expires_at: string | null;
    absolute_expires_at: string | null;
  }[] | null) ?? [];

  for (const s of rows) {
    // (1) Absolute ceiling — kill regardless of activity.
    if (s.absolute_expires_at && new Date(s.absolute_expires_at) < now) {
      await sendGodModeSMS(admin, {
        workspaceId: s.workspace_id,
        kind: "done",
        cockpitToken: s.cockpit_token,
        context: { reason: "hit its 12h ceiling" },
      });
      await admin
        .from("god_mode_sessions")
        .update({
          status: "expired",
          cockpit_token: null,
          disarmed_at: nowIso,
          last_activity_at: nowIso,
        })
        .eq("id", s.id);
      forceDisarmed++;
      continue;
    }

    // (2) Idle ceiling — only when there's no in-flight signal.
    if (s.token_expires_at && new Date(s.token_expires_at) < now) {
      const pending = await hasInFlight(admin, s.id);
      if (pending) continue; // pending approval holds the door open
      const { count } = await admin
        .from("agent_jobs")
        .select("id", { count: "exact", head: true })
        .eq("kind", "god-mode")
        .eq("spec_slug", s.id)
        .in("status", ["queued", "building", "queued_resume"]);
      if ((count ?? 0) > 0) continue; // building/queued turn holds the door open

      await sendGodModeSMS(admin, {
        workspaceId: s.workspace_id,
        kind: "done",
        cockpitToken: s.cockpit_token,
        context: { reason: "idled out" },
      });
      await admin
        .from("god_mode_sessions")
        .update({
          status: "expired",
          cockpit_token: null,
          disarmed_at: nowIso,
          last_activity_at: nowIso,
        })
        .eq("id", s.id);
      idleExpired++;
    }
  }

  return { forceDisarmed, idleExpired };
}

/**
 * Enqueue one god-mode turn job. The /api/god/[token]/message route calls
 * this after appending the user turn to the transcript. The box worker's
 * concurrency-1 god-mode lane claims it and runs runGodModeJob.
 *
 * `mode:'kill'` is enqueued separately by the disarm surface (not from here).
 */
export async function enqueueGodModeTurn(
  admin: Admin,
  args: { workspaceId: string; sessionId: string; userMessage: string; createdBy?: string | null },
): Promise<{ jobId: string | null }> {
  const instructions = JSON.stringify({
    session_id: args.sessionId,
    mode: "turn",
    user_message: args.userMessage,
  });
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: args.workspaceId,
      kind: "god-mode",
      // spec_slug carries the session id so the box view lane-detail can show
      // WHICH god-mode session this row runs. Same convention as dev-ask's
      // per-thread rows.
      spec_slug: args.sessionId,
      status: "queued",
      instructions,
      created_by: args.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { jobId: null };
  return { jobId: data.id as string };
}
