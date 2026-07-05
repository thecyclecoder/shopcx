---
name: recap
description: Use inside a live Claude Code session — invoked by `/recap` — to author the AUTHORITATIVE SessionDigest for THIS conversation from its own ground truth (what you actually did, decided, and left open) and upsert it into public.pulse_session_digests with digest_model='session-authored', so the SessionEnd Haiku ingest can never clobber a founder-witnessed recap with a paraphrased transcript-skim.
---

# recap

**When:** the founder types `/recap` in a live Claude Code session (or the assistant judges the session should be captured before context compresses).

**Why:** the SessionEnd Haiku ingest (`scripts/pulse-digest.ts` via [[../../src/lib/pulse-digest]]) reads the raw `.jsonl` after the fact and re-derives what happened from turn text. That's a paraphrase — it misses the WHY behind a decision, invents thread statuses from tone, and quotes ref values as "the recent PR" instead of the actual number. Running `/recap` INSIDE the session captures the digest from the model that already knows the truth: exact PR numbers, exact spec slugs, exact commit shas, and each thread's true `open | resolved | noise` status. The row lands with `digest_model='session-authored'` — Phase 2 uses that marker as the guard that stops the Haiku ingest from overwriting it.

**Same spine as the ingest.** No new table, no new column. The write goes through the SAME `upsertDigestRow` on `(workspace_id, session_id)` the ingest uses — one row per session, the session-authored row simply occupies it first with authoritative content. See [[../../docs/brain/tables/pulse_session_digests]] · [[../../docs/brain/libraries/pulse-digest]].

## Procedure

1. **Reflect on this session from your own memory** — the conversation you and the founder just had, not from re-reading `.jsonl`. Do NOT open the transcript file; you already know what happened. Focus on:
   - What the founder was trying to accomplish → `intent`.
   - Where they left off → `resume_point` (their last concrete question/action; explicit, not "we were discussing X").
   - The actual decisions made in-session (0–5) → `decisions[]`.
   - The threads of work touched (0–5) → `threads[]`. Set each thread's `status` honestly:
     - `resolved` — the work landed (PR merged, spec shipped, question answered, code deployed).
     - `open` — real work still owed to this thread.
     - `noise` — the founder raised it and dropped it, or it turned out to be a false start.
   - The pointers the session named (0–10) → `refs[]`. `kind` ∈ `spec | brain | file | url | commit | pr | migration`. **Use EXACT values:** the real spec slug (`pulse-session-authored-recaps`, not "the recap spec"), the real PR number (`1160`, not "the recent PR"), the real commit sha, the real migration filename (`20260812120000_pulse_session_digests.sql`).

2. **Anchor every non-trivial field with a `cite`.** For each `decisions[].summary` and each `threads[].title`, add a `cite` string — a short phrase from a real turn that anchors this claim (same discipline the ingest's `SYSTEM_PROMPT` requires). No free-floating claims.

3. **Pipe the JSON to `pulse-recap.ts`.** Compose the SessionDigest as a JSON object and invoke the write path via a bash heredoc:

   ```sh
   cat <<'JSON' | npx tsx scripts/pulse-recap.ts
   {
     "intent": "…",
     "resume_point": "…",
     "decisions": [ { "summary": "…", "cite": "…" } ],
     "threads":   [ { "title": "…", "status": "open|resolved|noise", "cite": "…" } ],
     "refs":      [ { "kind": "pr", "value": "1160" } ]
   }
   JSON
   ```

   The script:
   - Resolves the current `session_id` **deterministically** — no more newest-by-mtime guessing (that misfired on 2026-07-05 and overwrote a concurrent session's row). Priority order:
     1. `--session-id={id}` — explicit caller override.
     2. `process.env.CLAUDE_CODE_SESSION_ID` — the harness's own signal (Claude Code sets it to the current session UUID, which is exactly the `*.jsonl` basename under `~/.claude/projects/{cwd-slug}/`).
     3. mtime fallback — **only** when neither of the above is available AND **exactly one** transcript was modified in the last ~60s. Two-or-more → the script refuses and exits non-zero with the ambiguity error; pass `--session-id=…` to disambiguate.
   - Upserts on `(workspace_id, session_id)` via `upsertDigestRow` — SAME spine as the ingest → one row per session, no duplicates.
   - Stamps `digest_model='session-authored'` — the Phase-2 guard marker.
   - Prints one summary line: `[pulse-recap] upserted session=… via={flag|harness-env|mtime-unique} workspace=… digest_model=session-authored threads=N refs=M`. The `via=` field surfaces which resolver step fired so you can tell a real harness resolution from a mtime fallback at a glance.

4. **Read back the summary line** and tell the founder what landed (session id, thread count, ref count). If the script exits non-zero, surface the error — do not retry blindly.

## Guardrails

- **Exact values only in `refs[]`.** A `pr` ref must be the number (`1160`), not `"the PR"`. A `commit` ref must be the sha. A `spec` ref must be the exact slug. A `migration` ref must be the filename. If you don't know the exact value, omit the ref — don't fabricate.
- **Thread status is your judgment, not a default.** The Haiku ingest defaults `open` because it can't tell; you can. If the founder said "ship it" and the PR merged, that thread is `resolved`.
- **Don't re-open a `.jsonl`.** You already know what happened. Reading the transcript makes you paraphrase yourself — the whole point of session-authored is *witnessed*, not re-derived.
- **Don't run `/recap` twice reflexively.** The upsert is idempotent — a second run just overwrites in place. Fine when the founder asks for a refresh; noisy if you self-trigger.
- **Read-only against every table other than `pulse_session_digests`.** This skill writes ONE row on the (workspace, session) spine and touches nothing else.
- **Refuse-on-ambiguity, don't guess.** If the script exits with `refusing to guess the current session_id: N transcripts were modified in the last 60s`, do NOT retry with a shorter window or a --project-dir hack — that's the exact class of guess the 2026-07-05 incident produced. Pass `--session-id=…` (grab it from `CLAUDE_CODE_SESSION_ID` or the `~/.claude/projects/{cwd-slug}/{uuid}.jsonl` filename) and re-run.

## Related

- [[../../docs/brain/specs/pulse-session-authored-recaps]] — Phase 1 spec
- [[../../docs/brain/libraries/pulse-digest]] — the shared writer (`upsertDigestRow`) + digest-model precedence rule
- [[../../docs/brain/tables/pulse_session_digests]] — the row this writes
- [[../../src/lib/pulse-digest]] — `normalizeDigest`, `upsertDigestRow`, `DigestRef` (kinds now include `migration`)
- `scripts/pulse-recap.ts` — the runnable this skill drives
- Contrast with `scripts/pulse-digest.ts` — the SessionEnd forget-fallback that ingests `*.jsonl` via Haiku (Phase 2 makes it non-clobbering when a session-authored row exists)
