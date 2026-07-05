/**
 * Regression tests for pulse-recap's session resolution — the 2026-07-05 clobber guard.
 *
 * The incident: a /recap run from the MAIN repo (after the session's git worktree was removed)
 * couldn't find the env-id's transcript under the current cwd's project dir, fell through to the
 * mtime fallback, and picked a DIFFERENT (concurrent) session's newest transcript — overwriting
 * that session's digest row. These pin that an authoritative flag/env id is honored across ALL
 * project dirs and NEVER falls to mtime.
 *
 *   npx tsx --test scripts/pulse-recap.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveCurrentSession, findTranscriptAcrossProjects, SessionAmbiguityError } from "./pulse-recap";

function scaffold(): { root: string; touch: (slug: string, id: string, mtimeMs?: number) => string } {
  const root = mkdtempSync(join(tmpdir(), "pulse-recap-test-"));
  const touch = (slug: string, id: string, mtimeMs?: number): string => {
    const dir = join(root, slug);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, `${id}.jsonl`);
    writeFileSync(fp, "{}\n");
    if (mtimeMs !== undefined) utimesSync(fp, new Date(mtimeMs), new Date(mtimeMs));
    return fp;
  };
  return { root, touch };
}

test("THE CLOBBER GUARD: env id whose transcript lives under a DIFFERENT project dir wins over a newer concurrent transcript (never mtime)", () => {
  const { root, touch } = scaffold();
  const now = 1_000_000_000_000;
  const mainSlug = "-Users-admin-Projects-shopcx";
  const worktreeSlug = "-Users-admin-Projects-shopcx--claude-worktrees-x";
  // The env session ran in a worktree (its transcript is under the worktree slug).
  const envFp = touch(worktreeSlug, "ENV-SESSION", now - 5000);
  // A concurrent session's transcript sits under the CURRENT cwd's project dir, modified just now.
  touch(mainSlug, "CONCURRENT-SESSION", now - 1000);

  const r = resolveCurrentSession({
    projectDir: join(root, mainSlug),
    envSessionId: "ENV-SESSION",
    projectsRoot: root,
    nowMs: now,
  });
  assert.equal(r.session_id, "ENV-SESSION", "must honor the env id, NOT the concurrent mtime winner");
  assert.equal(r.via, "harness-env");
  assert.equal(r.filepath, envFp);
});

test("env id with NO transcript anywhere still wins (honor the id, null filepath, never mtime)", () => {
  const { root, touch } = scaffold();
  const now = 1_000_000_000_000;
  const mainSlug = "-main";
  // A concurrent transcript exists + is recent — the pre-fix code would have picked it.
  touch(mainSlug, "CONCURRENT", now - 1000);

  const r = resolveCurrentSession({
    projectDir: join(root, mainSlug),
    envSessionId: "GONE-WORKTREE-SESSION",
    projectsRoot: root,
    nowMs: now,
  });
  assert.equal(r.session_id, "GONE-WORKTREE-SESSION");
  assert.equal(r.via, "harness-env-no-transcript");
  assert.equal(r.filepath, null);
});

test("explicit --session-id is located across projects too (no --project-dir needed)", () => {
  const { root, touch } = scaffold();
  const fp = touch("-some-other-cwd", "FLAG-SESSION", 1_000);
  const r = resolveCurrentSession({
    projectDir: join(root, "-current-cwd"),
    flagSessionId: "FLAG-SESSION",
    projectsRoot: root,
    nowMs: 2_000,
  });
  assert.equal(r.session_id, "FLAG-SESSION");
  assert.equal(r.via, "flag");
  assert.equal(r.filepath, fp);
});

test("mtime fallback still works when NEITHER flag nor env is set (exactly one recent)", () => {
  const { root, touch } = scaffold();
  const now = 1_000_000_000_000;
  const slug = "-cwd";
  touch(slug, "ONLY-RECENT", now - 2000);
  touch(slug, "OLD-IDLE", now - 5 * 60_000); // outside the window
  const r = resolveCurrentSession({ projectDir: join(root, slug), projectsRoot: root, nowMs: now });
  assert.equal(r.session_id, "ONLY-RECENT");
  assert.equal(r.via, "mtime-unique");
});

test("mtime fallback still REFUSES two-or-more recent transcripts (no guessing)", () => {
  const { root, touch } = scaffold();
  const now = 1_000_000_000_000;
  const slug = "-cwd";
  touch(slug, "A", now - 1000);
  touch(slug, "B", now - 2000);
  assert.throws(
    () => resolveCurrentSession({ projectDir: join(root, slug), projectsRoot: root, nowMs: now }),
    (e: unknown) => e instanceof SessionAmbiguityError,
  );
});

test("findTranscriptAcrossProjects finds an id under any project dir; null when absent", () => {
  const { root, touch } = scaffold();
  const fp = touch("-a-b-c", "FINDME", 1);
  assert.equal(findTranscriptAcrossProjects("FINDME", root), fp);
  assert.equal(findTranscriptAcrossProjects("NOPE", root), null);
});
