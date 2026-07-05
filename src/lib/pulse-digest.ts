/**
 * pulse-digest — LLM-distiller for the founder's local Claude sessions.
 *
 * Reads *.jsonl files from a Claude Code project directory (the founder's
 * local ~/.claude/projects/-Users-admin-Projects-shopcx/ on their Mac),
 * extracts human turns + terminal actions, calls the Anthropic API to
 * distill each session into a compact digest, and upserts the result into
 * public.pulse_session_digests (idempotent on session_id).
 *
 * Phase 1 of docs/brain/specs/founder-pulse.md. The Phase-2 synthesizer
 * (src/lib/pulse.ts) joins these rows against the specs / agent_jobs ledger
 * to write the five lenses that render on /dashboard/developer/pulse.
 *
 * Runs LOCALLY on the founder's Mac (the build box has no filesystem
 * access to ~/.claude/projects/…). The runnable is scripts/pulse-digest.ts.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createAdminClient } from "@/lib/supabase/admin";
import { HAIKU_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/** One decision the founder / assistant made during the session. */
export interface DigestDecision {
  summary: string;
  cite?: string;
}

/** A thread of work the session touched — an idea, question, or spec slug in flight. */
export interface DigestThread {
  title: string;
  status?: "open" | "resolved" | "noise";
  cite?: string;
}

/**
 * A pointer the session referenced. `migration` is new in the session-authored
 * path (docs/brain/specs/pulse-session-authored-recaps.md) — the assistant
 * cites `supabase/migrations/*.sql` filenames by name; keeping them as their
 * own kind (not `file`) lets Phase 3 reconciliation match on the exact
 * migration filename instead of a slug-substring guess.
 */
export interface DigestRef {
  kind: "spec" | "brain" | "file" | "url" | "commit" | "pr" | "migration";
  value: string;
}

/** The accepted `DigestRef.kind` vocabulary — single source of truth for validators. */
export const DIGEST_REF_KINDS: DigestRef["kind"][] = ["spec", "brain", "file", "url", "commit", "pr", "migration"];

/** The structured digest of one session — mirrors the pulse_session_digests columns. */
export interface SessionDigest {
  intent: string;
  resume_point: string;
  decisions: DigestDecision[];
  threads: DigestThread[];
  refs: DigestRef[];
}

/** One row in pulse_session_digests (relevant columns). */
export interface DigestRow extends SessionDigest {
  session_id: string;
  project: string;
  started_at: string | null;
  last_activity_at: string | null;
  digest_model: string;
  source_mtime_ms: number;
  source_size_bytes: number;
}

/** Result of ingesting one project directory. */
export interface IngestResult {
  scanned: number;
  distilled: number;
  skipped_unchanged: number;
  upserted: number;
  errors: Array<{ session_id: string; message: string }>;
}

const DEFAULT_HUMAN_TURN_CAP = 40; // hard cap on how many human turns we pass to the model
const RESUME_TAIL_TURNS = 4;
const INTENT_HEAD_TURNS = 1;

/**
 * Extract the plain-text of a human turn from a jsonl line's parsed object.
 *
 * Claude Code jsonl rows can carry `content` as a string (older sessions) or
 * an array of blocks (the tool-call format). A row counts as a human turn
 * only when `message.role === 'user'` AND no block is a `tool_result` —
 * `tool_result` rows are the SDK returning tool output, not the founder
 * speaking. Returns null when the row is not a genuine human turn.
 */
export function extractHumanTurnText(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const msg = r.message as Record<string, unknown> | undefined;
  if (!msg || msg.role !== "user") return null;
  const content = msg.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_result") return null; // not a human turn
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

/**
 * Extract the first ISO timestamp from a jsonl row, best-effort. Rows carry
 * a top-level `timestamp` field in Claude Code's format.
 */
export function extractTimestamp(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const t = (row as Record<string, unknown>).timestamp;
  return typeof t === "string" ? t : null;
}

/**
 * Parse a jsonl file into an ordered list of human turns + boundary timestamps.
 * Malformed lines are skipped (the tail of an in-flight file often has one).
 */
export function parseSessionFile(text: string): { turns: string[]; firstAt: string | null; lastAt: string | null } {
  const turns: string[] = [];
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const at = extractTimestamp(row);
    if (at) {
      if (!firstAt) firstAt = at;
      lastAt = at;
    }
    const turn = extractHumanTurnText(row);
    if (turn) turns.push(turn);
  }
  return { turns, firstAt, lastAt };
}

/**
 * Trim the raw human-turn list to a shape the model can chew — first turn
 * (intent), last few turns (resume point), a sampling of the middle so
 * decisions aren't lost on a long session.
 */
export function shapeTurnsForModel(turns: string[], cap = DEFAULT_HUMAN_TURN_CAP): {
  head: string[];
  tail: string[];
  middle: string[];
} {
  if (turns.length <= cap) {
    return {
      head: turns.slice(0, INTENT_HEAD_TURNS),
      tail: turns.slice(-RESUME_TAIL_TURNS),
      middle: turns.slice(INTENT_HEAD_TURNS, Math.max(INTENT_HEAD_TURNS, turns.length - RESUME_TAIL_TURNS)),
    };
  }
  const head = turns.slice(0, INTENT_HEAD_TURNS);
  const tail = turns.slice(-RESUME_TAIL_TURNS);
  const middleBudget = Math.max(0, cap - head.length - tail.length);
  const middleAll = turns.slice(INTENT_HEAD_TURNS, turns.length - RESUME_TAIL_TURNS);
  // Uniform stride sample so we cover the arc of the session, not just the top.
  const middle: string[] = [];
  if (middleBudget > 0 && middleAll.length > 0) {
    const stride = middleAll.length / middleBudget;
    for (let i = 0; i < middleBudget; i++) {
      middle.push(middleAll[Math.floor(i * stride)]);
    }
  }
  return { head, tail, middle };
}

const SYSTEM_PROMPT = `You distill one Claude Code coding session into a compact structured digest. You receive the founder's human turns from a jsonl transcript in order (head = first turn, middle = a stride sample, tail = final turns). Return ONLY JSON matching this schema:
{
  "intent": string,               // one sentence — what this session was trying to accomplish (derive from the head turn)
  "resume_point": string,         // one sentence — where the founder left off (derive from the tail turns; include the last concrete question/action)
  "decisions": [                  // 0-5 concrete decisions the founder made in-session
    { "summary": string, "cite": string }   // cite = the short phrase from the turn that anchors this
  ],
  "threads": [                    // 0-5 threads of work the session touched (specs, ideas, questions)
    { "title": string, "status": "open" | "resolved" | "noise", "cite": string }
  ],
  "refs": [                       // 0-10 pointers the founder mentioned by name
    { "kind": "spec" | "brain" | "file" | "url" | "commit" | "pr" | "migration", "value": string }
  ]
}
Rules: NO free-floating claims — every decisions[].summary and threads[].title must have a cite drawn from a real turn. If the session is trivial (a one-line question), return minimal fields but never an empty intent.`;

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Call Anthropic to distill a single session's shaped turns into a
 * SessionDigest. Returns null when the API is unavailable or the response
 * won't parse — the caller falls back to a heuristic digest so we still
 * produce a row (never lose a session to a transient outage).
 */
export async function distillWithModel(turns: { head: string[]; middle: string[]; tail: string[] }, model = HAIKU_MODEL): Promise<{ digest: SessionDigest; usage: AnthropicMessagesResponse["usage"] } | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const user = JSON.stringify(
    {
      head: turns.head,
      middle: turns.middle,
      tail: turns.tail,
    },
    null,
    2,
  );
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as AnthropicMessagesResponse;
    const raw = (json.content?.[0]?.text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    const parsed = JSON.parse(raw.slice(first, last + 1)) as Partial<SessionDigest>;
    const digest = normalizeDigest(parsed);
    return { digest, usage: json.usage };
  } catch {
    return null;
  }
}

/** Coerce a parsed model response into a valid SessionDigest, dropping malformed rows. */
export function normalizeDigest(raw: Partial<SessionDigest> | null | undefined): SessionDigest {
  const decisions: DigestDecision[] = Array.isArray(raw?.decisions)
    ? raw!.decisions
        .filter((d): d is DigestDecision => !!d && typeof d.summary === "string" && d.summary.trim().length > 0)
        .map((d) => ({ summary: d.summary.trim(), cite: d.cite?.trim() || undefined }))
        .slice(0, 5)
    : [];
  const threads: DigestThread[] = Array.isArray(raw?.threads)
    ? raw!.threads
        .filter((t): t is DigestThread => !!t && typeof t.title === "string" && t.title.trim().length > 0)
        .map((t): DigestThread => ({
          title: t.title.trim(),
          status: t.status === "resolved" || t.status === "noise" ? t.status : "open",
          cite: t.cite?.trim() || undefined,
        }))
        .slice(0, 5)
    : [];
  const refs: DigestRef[] = Array.isArray(raw?.refs)
    ? raw!.refs
        .filter((r): r is DigestRef => !!r && typeof r.value === "string" && r.value.trim().length > 0)
        .map((r) => ({
          kind: (DIGEST_REF_KINDS.includes(r.kind as DigestRef["kind"]) ? r.kind : "file") as DigestRef["kind"],
          value: r.value.trim(),
        }))
        .slice(0, 10)
    : [];
  return {
    intent: (raw?.intent || "").toString().trim(),
    resume_point: (raw?.resume_point || "").toString().trim(),
    decisions,
    threads,
    refs,
  };
}

/**
 * Heuristic fallback when the model is unavailable — use the first turn as
 * the intent and the last turn as the resume point so we still produce a
 * usable row. Always returns a valid digest.
 */
export function heuristicDigest(turns: string[]): SessionDigest {
  const first = turns[0] || "";
  const last = turns[turns.length - 1] || "";
  const clip = (s: string, n = 240) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
  return {
    intent: clip(first),
    resume_point: clip(last),
    decisions: [],
    threads: [],
    refs: [],
  };
}

/**
 * Build a DigestRow for one session file. Returns null when the file has
 * zero human turns (a pure tool-loop transcript with no founder input).
 */
export async function digestSessionFile(opts: {
  filepath: string;
  session_id: string;
  project: string;
  model?: string;
}): Promise<DigestRow | null> {
  const stat = statSync(opts.filepath);
  const text = readFileSync(opts.filepath, "utf8");
  const { turns, firstAt, lastAt } = parseSessionFile(text);
  if (turns.length === 0) return null;
  const shaped = shapeTurnsForModel(turns);
  const model = opts.model || HAIKU_MODEL;
  const modelResult = await distillWithModel(shaped, model);
  const digest = modelResult?.digest || heuristicDigest(turns);
  return {
    session_id: opts.session_id,
    project: opts.project,
    started_at: firstAt,
    last_activity_at: lastAt,
    intent: digest.intent,
    resume_point: digest.resume_point,
    decisions: digest.decisions,
    threads: digest.threads,
    refs: digest.refs,
    digest_model: modelResult ? model : "heuristic",
    source_mtime_ms: Math.floor(stat.mtimeMs),
    source_size_bytes: stat.size,
  };
}

/**
 * Upsert one digest row into pulse_session_digests. Idempotent on
 * (workspace_id, session_id) — the unique constraint in the migration.
 */
export async function upsertDigestRow(admin: ReturnType<typeof createAdminClient>, workspaceId: string, row: DigestRow): Promise<void> {
  const { error } = await admin
    .from("pulse_session_digests")
    .upsert(
      {
        workspace_id: workspaceId,
        session_id: row.session_id,
        project: row.project,
        started_at: row.started_at,
        last_activity_at: row.last_activity_at,
        intent: row.intent,
        resume_point: row.resume_point,
        decisions: row.decisions,
        threads: row.threads,
        refs: row.refs,
        digest_model: row.digest_model,
        source_mtime_ms: row.source_mtime_ms,
        source_size_bytes: row.source_size_bytes,
      },
      { onConflict: "workspace_id,session_id" },
    );
  if (error) throw new Error(`upsertDigestRow: ${error.message}`);
}

/**
 * Log Anthropic token usage for a session digest — best-effort, never throws.
 * Wraps logAiUsage with a stable purpose tag so cost tracking can attribute
 * the pulse ingest separately from customer-facing paths.
 */
export async function logDigestUsage(workspaceId: string, model: string, usage: AnthropicMessagesResponse["usage"]): Promise<void> {
  if (!usage) return;
  try {
    await logAiUsage({ workspaceId, model, usage, purpose: "pulse_digest", ticketId: null });
  } catch {
    // logAiUsage already swallows — the extra try/catch guards against a signature drift.
  }
}

/**
 * Ingest every *.jsonl under `projectDir` — skipping files whose
 * (mtime_ms, size_bytes) match a prior digest row (idempotent, cheap
 * repeat runs). Returns per-run counters + any per-session errors. Never
 * throws on a single-file failure — the founder shouldn't lose a whole
 * ingest because one transcript has bad JSON on the tail.
 */
export async function ingestProjectDirectory(opts: {
  workspaceId: string;
  projectDir: string;
  project: string;
  model?: string;
  admin?: ReturnType<typeof createAdminClient>;
}): Promise<IngestResult> {
  const admin = opts.admin || createAdminClient();
  const result: IngestResult = { scanned: 0, distilled: 0, skipped_unchanged: 0, upserted: 0, errors: [] };
  let entries: string[];
  try {
    entries = readdirSync(opts.projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    result.errors.push({ session_id: "", message: `readdir ${opts.projectDir}: ${(err as Error).message}` });
    return result;
  }
  const sessionIds = entries.map((f) => f.replace(/\.jsonl$/, ""));
  const priorBySession = new Map<string, { mtime: number; size: number }>();
  if (sessionIds.length > 0) {
    const { data } = await admin
      .from("pulse_session_digests")
      .select("session_id, source_mtime_ms, source_size_bytes")
      .eq("workspace_id", opts.workspaceId)
      .in("session_id", sessionIds);
    for (const r of data || []) {
      priorBySession.set(r.session_id as string, {
        mtime: Number(r.source_mtime_ms) || 0,
        size: Number(r.source_size_bytes) || 0,
      });
    }
  }
  for (const filename of entries) {
    result.scanned++;
    const session_id = filename.replace(/\.jsonl$/, "");
    const filepath = join(opts.projectDir, filename);
    try {
      const stat = statSync(filepath);
      const prior = priorBySession.get(session_id);
      if (prior && prior.mtime === Math.floor(stat.mtimeMs) && prior.size === stat.size) {
        result.skipped_unchanged++;
        continue;
      }
      const row = await digestSessionFile({ filepath, session_id, project: opts.project, model: opts.model });
      if (!row) continue;
      result.distilled++;
      await upsertDigestRow(admin, opts.workspaceId, row);
      result.upserted++;
    } catch (err) {
      result.errors.push({ session_id, message: (err as Error).message });
    }
  }
  return result;
}

/**
 * Render a UTC ISO timestamp in America/Puerto_Rico (AST, UTC-4, no DST).
 * The bug the founder already hit was displaying local session 4e303b13's
 * timestamps in UTC — this helper is the single-source rendering the /pulse
 * page uses so display never drifts from the ingest normalization.
 */
export function formatAstTimestamp(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      timeZone: "America/Puerto_Rico",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
