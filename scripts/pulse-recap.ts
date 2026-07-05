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

/**
 * Resolve the current session's `.jsonl` transcript: newest-modified file
 * under `projectDir`. Called by an assistant tool INSIDE a live session, so
 * the current session's jsonl is (by construction) the freshest one — the
 * assistant just wrote a turn to trigger this bash call.
 *
 * Returns null when the directory is empty / missing (a fresh install with
 * no transcripts yet) — the caller reports and exits 1.
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

  // Resolve session_id + its jsonl (for timestamps + the idempotency fingerprint).
  let session_id = flags["session-id"] || "";
  let filepath = "";
  if (session_id) {
    filepath = join(projectDir, `${session_id}.jsonl`);
    if (!existsSync(filepath)) {
      console.error(`[pulse-recap] --session-id=${session_id} but no transcript at ${filepath}`);
      process.exit(1);
    }
  } else {
    const newest = findNewestSessionJsonl(projectDir);
    if (!newest) {
      console.error(`[pulse-recap] no *.jsonl transcripts under ${projectDir} — pass --session-id=… to override.`);
      process.exit(1);
    }
    session_id = newest.session_id;
    filepath = newest.filepath;
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

  const { firstAt, lastAt } = extractBoundaryTimestamps(filepath);
  const stat = statSync(filepath);
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
    source_mtime_ms: Math.floor(stat.mtimeMs),
    source_size_bytes: stat.size,
  };

  const admin = createAdminClient();
  await upsertDigestRow(admin, workspaceId, row);
  console.log(
    `[pulse-recap] upserted session=${session_id} workspace=${workspaceId} digest_model=${SESSION_AUTHORED_MODEL} threads=${digest.threads.length} refs=${digest.refs.length}`,
  );
}

main().catch((e) => {
  console.error(`[pulse-recap] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
