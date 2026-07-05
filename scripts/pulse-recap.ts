// pulse-recap — SESSION-AUTHORED digest write for the current Claude Code
// session. Runs INSIDE a live session (invoked by the /recap skill after the
// assistant distills THIS conversation into a SessionDigest from its own
// ground truth) — not to be confused with `scripts/pulse-digest.ts`, which
// is the SessionEnd forget-fallback that reads *.jsonl and calls Haiku.
//
// Phase 1 of docs/brain/specs/pulse-session-authored-recaps.md.
//
// Reads a JSON SessionDigest payload from stdin:
//   { "intent": "...", "resume_point": "...",
//     "decisions": [ { "summary": "...", "cite": "..." } ],
//     "threads":   [ { "title": "...", "status": "open|resolved|noise", "cite": "..." } ],
//     "refs":      [ { "kind": "spec|pr|commit|migration|brain|file|url", "value": "..." } ] }
//
// Upserts one row into public.pulse_session_digests on
// (workspace_id, session_id) via src/lib/pulse-digest.ts upsertDigestRow with
// digest_model='session-authored' — the authoritative marker Phase 2 checks
// before letting the Haiku ingest clobber a session-authored row.
//
// Usage (inside a live Claude Code session):
//   cat <<'JSON' | npx tsx scripts/pulse-recap.ts
//   { "intent": "...", ... }
//   JSON
//
// Optional flags:
//   --session-id={id}     override auto-resolution (jsonl basename)
//   --workspace-id={uuid} override default workspace
//   --project-dir={path}  override ~/.claude/projects/{cwd-slug}
//
// Session resolution order (deterministic — no more mtime-first guessing):
//   1. --session-id={id}                     (explicit caller override)
//   2. process.env.CLAUDE_CODE_SESSION_ID    (the harness's own signal —
//      Claude Code sets it to the current session UUID, which is exactly the
//      *.jsonl basename)
//   3. mtime fallback — ONLY when NEITHER of the above is set AND EXACTLY ONE
//      transcript was modified in the last ~60s. Two-or-more → refuse.
//
// An explicit (1) or harness (2) id is AUTHORITATIVE and NEVER falls through to
// the mtime guess. Its transcript is located across EVERY ~/.claude/projects/*
// dir (not just the current cwd's slug) so a session that ran in a git worktree
// or nested cwd is still found; if the transcript is genuinely gone (a removed
// worktree) we STILL honor the stated id (with best-effort null boundary
// timestamps) rather than guess a different session. This closes the 2026-07-05
// incident TWICE over: once (the original) a stale-newest mtime guess overwrote a
// concurrent session's row; and again (2026-07-05, second occurrence) a recap run
// from the main repo after a worktree was removed didn't find the env-id's
// transcript under the current projectDir, fell to mtime, and clobbered a
// concurrent session that had just run /recap itself.
//
// Idempotent on (workspace_id, session_id): re-running /recap in the SAME
// session overwrites the row in place — one row per session.
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { createAdminClient } from "./_bootstrap";
import {
  DigestRow,
  normalizeDigest,
  SESSION_AUTHORED_MODEL,
  SessionDigest,
  upsertDigestRow,
} from "../src/lib/pulse-digest";

const DEFAULT_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// Re-export so imports of `SESSION_AUTHORED_MODEL` from this script keep working — the
// canonical definition lives in src/lib/pulse-digest.ts (single source of truth).
export { SESSION_AUTHORED_MODEL };

/**
 * Parse `--key=value` flags. Positional args are ignored (this script takes
 * its payload on stdin).
 */
export function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    out[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return out;
}

/**
 * Map an absolute filesystem path to Claude Code's project-directory slug:
 * `/home/builder/builds/x` → `-home-builder-builds-x`. Same convention
 * Claude Code itself uses to bucket ~/.claude/projects/{slug}/*.jsonl.
 */
export function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/** Window used by the mtime fallback — a transcript is considered "live" only
 * if it was written to inside this many ms. Small enough that a genuinely-idle
 * older session can't be mistaken for the caller's session; large enough that
 * a slow turn (Bash, model latency) doesn't drop us into the empty branch. */
export const MTIME_LIVE_WINDOW_MS = 60_000;

/** Env var the Claude Code harness sets to the current session's UUID
 * (matches the `*.jsonl` basename under `~/.claude/projects/{cwd-slug}/`).
 * The deterministic resolver's #2 signal — no probing, no guessing. */
export const HARNESS_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

/** Structured error thrown by `resolveCurrentSession` when the mtime fallback
 * would have to guess between two-or-more concurrent transcripts. Carries the
 * candidate ids so the caller's message can name them without re-scanning. */
export class SessionAmbiguityError extends Error {
  readonly candidates: string[];
  readonly windowMs: number;
  constructor(candidates: string[], windowMs: number) {
    super(
      `refusing to guess the current session_id: ${candidates.length} transcripts were modified in the last ${Math.round(
        windowMs / 1000,
      )}s (${candidates.join(", ")}). Pass --session-id=… (or set ${HARNESS_SESSION_ENV}) to disambiguate.`,
    );
    this.name = "SessionAmbiguityError";
    this.candidates = candidates;
    this.windowMs = windowMs;
  }
}

/** Result of `resolveCurrentSession`. `via` records which resolver step
 * fired — useful in logs when a caller wants to know whether the deterministic
 * harness signal was actually available or whether we fell through to mtime. */
export type ResolvedSession = {
  session_id: string;
  /** The session's transcript, if we could locate it (under projectDir OR any other
   *  ~/.claude/projects/* dir — a worktree/nested-cwd session lives under a different slug).
   *  `null` when the id is authoritative (flag/env) but no transcript file was found anywhere —
   *  recap authors from the piped digest, not the transcript, so a null filepath just means
   *  best-effort boundary timestamps, NOT a failure. */
  filepath: string | null;
  via: "flag" | "flag-no-transcript" | "harness-env" | "harness-env-no-transcript" | "mtime-unique";
};

/**
 * Locate a session's transcript across EVERY `~/.claude/projects/*` dir, not just the current
 * cwd's slug. A session that ran in a git worktree (or any nested cwd) writes its `{id}.jsonl`
 * under that cwd's slug — so a recap invoked from a DIFFERENT cwd (e.g. after the worktree was
 * removed) won't find it under the current `projectDir`. Returns the first match's absolute path,
 * or null if no `{sessionId}.jsonl` exists under any project dir. `projectsRoot` defaults to
 * `~/.claude/projects`.
 */
export function findTranscriptAcrossProjects(
  sessionId: string,
  projectsRoot: string = join(homedir(), ".claude/projects"),
): string | null {
  if (!existsSync(projectsRoot)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = join(projectsRoot, d, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Deterministic session resolution. Priority order (see file header):
 *   1. `flagSessionId` — the caller's explicit `--session-id`.
 *   2. `envSessionId` — the harness's `CLAUDE_CODE_SESSION_ID`.
 *   3. mtime fallback — ONLY if exactly one transcript was modified in the
 *      last `windowMs` (default 60_000). Two-or-more → throws
 *      `SessionAmbiguityError` (concurrent sessions can't be told apart by
 *      mtime; the caller must pass `--session-id`). Zero-in-window → throws a
 *      plain Error (no live session; a stale-newest guess is exactly the
 *      2026-07-05 misfire we're fixing).
 *
 * For (1) and (2), the stated id IS the answer — it's authoritative, so we NEVER fall through to
 * the mtime guess (that's how the 2026-07-05 clobber happened: a recap run from a different cwd
 * than the session's own — a git worktree that was later removed — didn't find the env-id's
 * transcript under the current `projectDir`, fell to mtime, and overwrote a CONCURRENT session's
 * row). We look for the transcript across EVERY project dir (`findTranscriptAcrossProjects`) so a
 * worktree/nested-cwd session is still located; if it's genuinely missing we STILL use the stated
 * id (with a null filepath → best-effort boundary timestamps) rather than guess a different one.
 * mtime is reached ONLY when neither a flag nor the env id is present.
 */
export function resolveCurrentSession(opts: {
  projectDir: string;
  flagSessionId?: string;
  envSessionId?: string;
  nowMs?: number;
  windowMs?: number;
  projectsRoot?: string;
}): ResolvedSession {
  const { projectDir } = opts;
  const windowMs = opts.windowMs ?? MTIME_LIVE_WINDOW_MS;
  const projectsRoot = opts.projectsRoot;

  // (1)/(2): an explicit --session-id or the harness CLAUDE_CODE_SESSION_ID is AUTHORITATIVE.
  // Locate its transcript (under projectDir first, then any other project dir); if not found
  // anywhere, still honor the id — NEVER fall to mtime, which could clobber a concurrent session.
  const stated = opts.flagSessionId ?? opts.envSessionId;
  if (stated) {
    const local = join(projectDir, `${stated}.jsonl`);
    const filepath = existsSync(local) ? local : findTranscriptAcrossProjects(stated, projectsRoot);
    const fromFlag = !!opts.flagSessionId;
    if (filepath) return { session_id: stated, filepath, via: fromFlag ? "flag" : "harness-env" };
    return { session_id: stated, filepath: null, via: fromFlag ? "flag-no-transcript" : "harness-env-no-transcript" };
  }

  if (!existsSync(projectDir)) {
    throw new Error(
      `no transcripts directory at ${projectDir} — pass --session-id=… or set ${HARNESS_SESSION_ENV}.`,
    );
  }
  let entries: string[];
  try {
    entries = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    throw new Error(`could not read ${projectDir}: ${(err as Error).message}`);
  }
  if (entries.length === 0) {
    throw new Error(
      `no *.jsonl transcripts under ${projectDir} — pass --session-id=… or set ${HARNESS_SESSION_ENV}.`,
    );
  }

  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - windowMs;
  const recent: { session_id: string; filepath: string; mtimeMs: number }[] = [];
  for (const filename of entries) {
    const filepath = join(projectDir, filename);
    try {
      const stat = statSync(filepath);
      if (stat.mtimeMs >= cutoff) {
        recent.push({ session_id: filename.replace(/\.jsonl$/, ""), filepath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      continue;
    }
  }

  if (recent.length === 0) {
    throw new Error(
      `no *.jsonl under ${projectDir} was modified in the last ${Math.round(
        windowMs / 1000,
      )}s — no active session to recap. Pass --session-id=… or set ${HARNESS_SESSION_ENV}.`,
    );
  }
  if (recent.length > 1) {
    throw new SessionAmbiguityError(
      recent.map((r) => r.session_id),
      windowMs,
    );
  }
  const only = recent[0];
  return { session_id: only.session_id, filepath: only.filepath, via: "mtime-unique" };
}

/**
 * @deprecated Use `resolveCurrentSession` — mtime-newest was the misfire this
 * spec was written to fix (see 2026-07-05 incident in
 * `docs/brain/specs/recap-session-id-resolution.md`). Kept only so any
 * external caller that imported this symbol still type-checks.
 */
export function findNewestSessionJsonl(projectDir: string): { session_id: string; filepath: string } | null {
  if (!existsSync(projectDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  let bestFile: string | null = null;
  let bestMtime = -Infinity;
  for (const filename of entries) {
    const filepath = join(projectDir, filename);
    try {
      const stat = statSync(filepath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestFile = filename;
      }
    } catch {
      continue;
    }
  }
  if (!bestFile) return null;
  return { session_id: bestFile.replace(/\.jsonl$/, ""), filepath: join(projectDir, bestFile) };
}

/**
 * Extract first + last turn timestamps from a `.jsonl` transcript. Best-effort
 * — the session-authored digest supplies the semantic content; timestamps are
 * columnar bookkeeping so the /pulse renderer can sort recent-sessions-first.
 * Malformed lines silently skipped (in-flight files often have a partial tail).
 */
export function extractBoundaryTimestamps(filepath: string): { firstAt: string | null; lastAt: string | null } {
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  try {
    const text = readFileSync(filepath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: unknown;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const t = (row as Record<string, unknown> | null)?.timestamp;
      if (typeof t !== "string") continue;
      if (!firstAt) firstAt = t;
      lastAt = t;
    }
  } catch {
    // Read failure — leave both null; the row still upserts.
  }
  return { firstAt, lastAt };
}

/**
 * Coerce the parsed JSON payload into a valid `SessionDigest`. Delegates to
 * the shared `normalizeDigest` (single source of truth for the ref-kind
 * vocabulary) so the session-authored path and the SessionEnd Haiku ingest
 * validate on the same schema.
 */
export function normalizeSessionAuthoredDigest(raw: unknown): SessionDigest {
  const partial = (raw && typeof raw === "object" ? raw : {}) as Partial<SessionDigest>;
  return normalizeDigest(partial);
}

/** Read stdin to a single string. */
export function readStdin(): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveP(data));
    process.stdin.on("error", rejectP);
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const workspaceId = flags["workspace-id"] || process.env.PULSE_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;
  const projectDir = flags["project-dir"]
    ? resolve(flags["project-dir"].replace(/^~(?=$|\/)/, homedir()))
    : join(homedir(), ".claude/projects", cwdToProjectSlug(process.cwd()));
  const project = basename(projectDir);

  // Resolve session_id + its jsonl deterministically. Order:
  //   1. --session-id flag  → 2. CLAUDE_CODE_SESSION_ID env  → 3. mtime (only
  //   if exactly one transcript was modified in the last ~60s; two-or-more
  //   refuses rather than guessing). See file header for the incident this
  //   guards against.
  let session_id: string;
  let filepath: string | null;
  let via: ResolvedSession["via"];
  try {
    const resolved = resolveCurrentSession({
      projectDir,
      flagSessionId: flags["session-id"] || undefined,
      envSessionId: process.env[HARNESS_SESSION_ENV] || undefined,
    });
    session_id = resolved.session_id;
    filepath = resolved.filepath;
    via = resolved.via;
  } catch (err) {
    console.error(`[pulse-recap] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const stdinText = await readStdin();
  if (!stdinText.trim()) {
    console.error(`[pulse-recap] empty stdin — pipe the SessionDigest JSON.`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText);
  } catch (err) {
    console.error(`[pulse-recap] stdin is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  const digest = normalizeSessionAuthoredDigest(parsed);
  if (!digest.intent) {
    console.error(`[pulse-recap] digest.intent is empty — the session must have a stated intent.`);
    process.exit(1);
  }

  // filepath may be null when the id is authoritative (flag/env) but the transcript wasn't found
  // anywhere (a removed worktree). The digest still upserts — recap authors from the piped JSON, not
  // the transcript — so boundary timestamps + source stats are best-effort (null when absent).
  const { firstAt, lastAt } = filepath ? extractBoundaryTimestamps(filepath) : { firstAt: null, lastAt: null };
  const stat = filepath ? statSync(filepath) : null;
  const row: DigestRow = {
    session_id,
    project,
    started_at: firstAt,
    last_activity_at: lastAt,
    intent: digest.intent,
    resume_point: digest.resume_point,
    decisions: digest.decisions,
    threads: digest.threads,
    refs: digest.refs,
    digest_model: SESSION_AUTHORED_MODEL,
    source_mtime_ms: stat ? Math.floor(stat.mtimeMs) : 0,
    source_size_bytes: stat ? stat.size : 0,
  };

  const admin = createAdminClient();
  await upsertDigestRow(admin, workspaceId, row);
  console.log(
    `[pulse-recap] upserted session=${session_id} via=${via} workspace=${workspaceId} digest_model=${SESSION_AUTHORED_MODEL} threads=${digest.threads.length} refs=${digest.refs.length}`,
  );
}

main().catch((e) => {
  console.error(`[pulse-recap] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
