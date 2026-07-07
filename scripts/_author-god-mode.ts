import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "god-mode",
    {
      title: "God Mode — full-power box cockpit for the founder",
      why:
        "Until the CEO + director agents exist to remediate incidents autonomously, the founder needs a way to drive a FULL-POWER build-box session from his phone during an incident. Today a production crash happened while he was away from his desk and he could not remediate quickly. God Mode is a deliberately thin, disposable bridge that gives the founder a live terminal-equivalent to the box (reads/diagnostics fly, risky writes gate on a one-tap approval) — retired the moment the autonomous exec layer can self-remediate.",
      what:
        "A new owner-only God Mode surface: an ARMED, resumable Claude Code session on the build box running with REAL prod-write credentials, where every risky tool call (Write/Edit/Bash-mutation/migration/git push/deploy) pauses on a hard live permission gate. Approvals reach the founder as an SMS'd token 'cockpit' (a public, no-login page with two tabs — a live Chat transcript and an Approvals queue+history — Approve / Deny / Ask-a-question). Destructive/irreversible actions additionally require a founder PIN. The same session is also viewable in an in-app dashboard tab when at the desk. Armed deliberately from the authenticated app; auto-disarms on idle; hard 12h ceiling; instant kill switch. Built as an isolated lane (own tables + runner + page) so it can be cleanly removed when the CEO/director agents land.",
      summary:
        "Extends the box-session pattern proven by the dev-ask Developer Message Center (scripts/builder-worker.ts runDeveloperMessageJob ~10375; src/app/api/developer/messages/route.ts; docs/brain/dashboard/developer__messages.md) into an ELEVATED, live-gated lane. Reuses: the resumable runBoxSession runner (scripts/builder-worker.ts:1788) + claim_agent_job lane pattern; the public token-authed journey mini-site substrate (/journey/[token], src/lib/journey-delivery.ts, src/app/api/journey/[token]/*) for the no-login cockpit; the CX chat-widget realtime pattern (src/components/ticket-presence.tsx, src/app/widget/[workspaceId]/page.tsx) for the live transcript; sendSMS (src/lib/twilio.ts:33) for delivery; owner gating (requireOwner, src/app/api/developer/messages/route.ts:31-45; workspace role==='owner'). The single new capability vs every existing lane: the god-mode session runs with prod-write creds and a hard per-tool permission gate replacing --dangerously-skip-permissions (scripts/builder-worker.ts:1838).",
      owner: "ceo",
      parent:
        "[[../functions/ceo]] § Founder incident cockpit — the manual full-power founder bridge to the box for incident remediation while the autonomous CEO/director exec layer doesn't yet exist. A deliberate sunset stopgap, retired once the CEO-mode exec layer can self-remediate. One-off spec, no goal.",
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Session model + arm/disarm + PIN",
          why:
            "God Mode needs one source of truth for a live session (its box session id, its cockpit token, its armed lifecycle) and a secure, deliberate way to turn it on. Arming from the authenticated app is the security boundary — full prod-write only exists while the founder has deliberately armed it.",
          what:
            "Two new tables (god_mode_sessions, god_mode_approvals), an owner-gated arm/disarm API, and a hashed founder PIN. Arming mints a short-lived cockpit token and opens the window; disarm/kill invalidates the token and ends the session.",
          body:
            "Create `public.god_mode_sessions` — one active session per workspace: `id uuid pk`, `workspace_id uuid fk`, `created_by uuid` (the owner), `status text` (`armed｜disarmed｜expired`), `cockpit_token text` (48-hex, the /god/{token} slug — unguessable, like journey-delivery.ts:186), `token_expires_at timestamptz` (sliding TTL), `absolute_expires_at timestamptz` (arm + 12h hard ceiling), `box_session_id text?` + `box_session_config_dir text?` (captured from the claude -p stream for --resume, pinned to its Max account exactly like agent_jobs.claude_session_id / claude_session_config_dir), `messages jsonb` (transcript, [{role,content,ts}]), `last_activity_at timestamptz`, `armed_at`, `disarmed_at`, `created_at`.\n" +
            "Create `public.god_mode_approvals` — the approvals queue+history for a session: `id uuid pk`, `session_id uuid fk`, `workspace_id uuid`, `tool_name text`, `tool_input jsonb`, `preview text` (human-readable: the command / the diff / the migration SQL), `risk text` (`safe｜write｜destructive`), `status text` (`pending｜approved｜denied｜asked`), `question_text text?` (the founder's Ask), `decided_at timestamptz?`, `created_at`. This is its own table (NOT agent_jobs.pending_actions) because god-mode uses a live in-session gate, not the propose-then-worker-executes model — keeping it self-contained also keeps it cleanly removable.\n" +
            "Founder PIN: store a one-way HASH only (never the plaintext) — a `god_mode_pin_hash` on the workspace row or a dedicated 1-row config, hashed via the crypto conventions (src/lib/crypto.ts; column follows the `_encrypted`/hashed convention). The PIN value is set OUT-OF-BAND by a secure one-time setter script (a disposable scripts/_set-god-mode-pin.ts that reads the value from an arg/env and writes only the hash) — it is NEVER committed, never in the spec, never in the DB in plaintext.\n" +
            "API: `POST /api/god-mode/arm` (owner-gated via requireOwner, mirror src/app/api/developer/messages/route.ts:31-45) → upsert an `armed` session, mint `cockpit_token`, set `token_expires_at` (sliding seed) + `absolute_expires_at = now()+12h`, return the cockpit URL. `POST /api/god-mode/disarm` (owner-gated OR from the cockpit token) → status=`disarmed`, null the token, signal the box lane to end the session (kill switch).\n" +
            "Per CLAUDE.md hard rule: add `docs/brain/tables/god_mode_sessions.md` + `docs/brain/tables/god_mode_approvals.md` and a `docs/brain/lifecycles/god-mode.md` stub in this same PR.",
          verification:
            "npx tsc --noEmit is green. Migration applies: `god_mode_sessions` + `god_mode_approvals` exist with the columns above (verify with a read-only probe / _verify-schema script). `POST /api/god-mode/arm` as the owner returns 200 with a cockpit URL and inserts a row with status='armed', a 48-char cockpit_token, token_expires_at and absolute_expires_at set (~12h out); as a non-owner it returns 401/403 and inserts nothing. `POST /api/god-mode/disarm` flips status to 'disarmed' and nulls cockpit_token. A `_set-god-mode-pin.ts` run writes only a hash — the plaintext PIN never appears in the row (probe confirms the column is a hash, not '2514'). Brain pages for both tables + the lifecycle stub exist.",
          status: "planned",
        },
        {
          title: "Phase 2 — Full-power box lane + live permission gate",
          why:
            "This is the one genuinely new capability: a box session that ACTS with real prod-write powers, live, but stops dead on a hard approval gate for anything risky — mirroring how Claude Code prompts the founder in his own terminal. Reads fly; writes wait for a tap; destructive waits for the PIN.",
          what:
            "A new `god-mode` agent_jobs kind on a concurrency-1 lane, a resumable runGodModeJob that runs claude -p on Max in a stable per-session worktree with an ELEVATED sandbox (prod-write creds), and a PreToolUse permission gate that replaces --dangerously-skip-permissions: it classifies each tool call and either auto-allows (safe read-only), or opens a god_mode_approvals row and BLOCKS until the founder decides.",
          body:
            "Add `kind='god-mode'` to the dispatch table (scripts/builder-worker.ts dispatchJob ~17136) and a concurrency-1 lane (mirror MAX_DEV_ASK / MAX_TICKET_IMPROVE ~line 94-98). `job.instructions` JSON = `{ session_id, mode:'turn', user_message }` (+ a `mode:'kill'` to tear down).\n" +
            "`runGodModeJob`: load the god_mode_sessions row; `isResume = !!box_session_id`; run in a STABLE per-session worktree keyed by session id (the --resume transcript store is keyed by cwd — same stability requirement as runSpecChatJob ~8428-8440). Route through the shared runBoxSession (scripts/builder-worker.ts:1788) BUT with two deltas vs every existing lane:\n" +
            "  (1) ELEVATED sandbox — add a `godmode` env mode alongside `max`/`build` in the env block (scripts/builder-worker.ts:1810-1826). Unlike `build` (strips SECRET_RE) and unlike the read-only-by-convention `max` lanes, `godmode` intentionally passes prod-write credentials (Supabase service role, GitHub token, deploy creds) through to the claude -p process, still dropping ANTHROPIC_API_KEY so all inference is Max-billed. PROBE the exact env handling before implementing — confirm which creds runBoxSession currently forwards and add only what a real remediation needs.\n" +
            "  (2) HARD permission gate — for this lane do NOT pass `--dangerously-skip-permissions` (contrast scripts/builder-worker.ts:1838). Instead wire a PreToolUse permission hook (or `--permission-prompt-tool` MCP — pick per the installed Claude Code's supported mechanism; read node_modules/@anthropic-ai/claude-code docs per CLAUDE.md before choosing). The gate script runs on the box (it has DB creds) and, per tool call: SAFE read-only (Read/Grep/Glob/WebSearch + an allowlist of read-only Bash prefixes: git status/diff/log, ls, cat, npx tsc, SELECT-only psql) → auto-allow, no prompt. WRITE (Write/Edit/non-allowlisted Bash/git push/migration/deploy) → insert a god_mode_approvals row (status='pending', risk='write', with tool_name/tool_input/preview), then BLOCK by polling that row until it flips, returning allow on 'approved' and deny on 'denied'. DESTRUCTIVE (drop/delete/truncate/force-push/irreversible — classify via a deterministic rail over the command, reuse the spirit of classifyMigrationSql in src/lib/agents/platform-director.ts) → same, but risk='destructive' and the approve path additionally requires the founder PIN (verified in Phase 3's approve route; the gate just waits for status='approved'). ASK → the founder's Ask resolves the row status='asked' with question_text; the gate returns deny-WITH-the-question-as-message so the box reads it, responds in-transcript, and re-requests approval (a live back-and-forth, not a dead end).\n" +
            "While the gate is blocking OR a turn is streaming, the session is IN-FLIGHT (Phase 5's idle reaper must never disarm it). Capture the new box session_id + config_dir back onto god_mode_sessions after each turn for the next --resume.\n" +
            "Per CLAUDE.md: add `docs/brain/inngest/` or `docs/brain/libraries/` page(s) for the new runner + gate, and document the `godmode` sandbox mode + the permission gate in docs/brain/lifecycles/god-mode.md.",
          verification:
            "npx tsc --noEmit is green. A local/box harness turn proves: a read-only tool call (Read/Grep) runs WITHOUT creating a god_mode_approvals row; a Write/Edit/Bash-mutation call CREATES a god_mode_approvals row with status='pending' and blocks (the turn does not complete) until the row flips; flipping the row to 'approved' lets the tool proceed and the turn completes; flipping to 'denied' blocks the tool and the box continues without it; a destructive command is classified risk='destructive'. The god-mode claude -p is invoked WITHOUT --dangerously-skip-permissions (grep the runner). The `godmode` sandbox forwards a prod-write cred that `build` mode strips (confirm the env-mode branch exists). Concurrency-1 lane confirmed.",
          status: "planned",
        },
        {
          title: "Phase 3 — The SMS cockpit: token page with Chat + Approvals tabs",
          why:
            "The founder's primary surface when away from his desk. Delivered by SMS, opened with one tap, no login. An approval never arrives context-free — it sits next to the full chat that produced it, so the founder can actually be on the same page instead of rubber-stamping blind.",
          what:
            "A public, token-authed `/god/[token]` page with two tabs — a live Chat transcript (send instructions, watch replies, like the CX chat widget) and an Approvals queue+history (Approve / Deny / Ask; PIN input on destructive) — plus its GET/message/approve API routes.",
          body:
            "Page `src/app/god/[token]/page.tsx` (\"use client\") — validate the token against god_mode_sessions.cockpit_token AND status='armed' AND now()<token_expires_at AND now()<absolute_expires_at (public, token-IS-the-auth, exactly like src/app/api/journey/[token]/route.ts:4; use createAdminClient service role). Invalid/disarmed → 404; expired → 410. Two tabs (follow the in-repo tab pattern at src/app/dashboard/ai-analysis/page.tsx:69-144):\n" +
            "  • Chat tab: render god_mode_sessions.messages; a composer that POSTs a new instruction. Live updates via the CX-widget realtime pattern (src/components/ticket-presence.tsx Supabase channel) or a 2-3s poll fallback (mirror MessageCenterChat.tsx:80-108).\n" +
            "  • Approvals tab: render god_mode_approvals for the session (pending at top, history below). Each pending card shows tool_name + preview; buttons Approve / Deny / Ask (Ask reveals a text input). risk='destructive' cards additionally require the PIN field before Approve is enabled.\n" +
            "API (all token-authed, service role, bind to THIS session's token — copy the journey tamper-guard idea, complete/route.ts:864-879, so a token can only act on its own session): `GET /api/god/[token]` → return {messages, approvals, status}; renews token_expires_at (sliding) + bumps last_activity_at on open. `POST /api/god/[token]/message` → append the user turn to messages, enqueue a `kind='god-mode'` `mode:'turn'` job, renew TTL. `POST /api/god/[token]/approve` → body {approvalId, decision:'approve'|'deny'|'ask', question?, pin?}; on 'approve' of a risk='destructive' row, verify `pin` against god_mode_pin_hash (reject on mismatch — do NOT reveal validity beyond allow/deny) BEFORE flipping to 'approved'; 'deny' → 'denied'; 'ask' → 'asked' + question_text; every call renews TTL + bumps last_activity_at (the Phase-5 in-flight signal).\n" +
            "Per CLAUDE.md: document routes in docs/brain/lifecycles/god-mode.md; if a new src/lib helper file is added, give it a libraries/ brain page.",
          verification:
            "npx tsc --noEmit is green. Opening `/god/{valid armed token}` renders the two-tab cockpit; a random/expired/disarmed token returns 404/410. Chat tab lists the session transcript; posting a message via `POST /api/god/[token]/message` enqueues a god-mode agent_jobs row and appends the turn. Approvals tab lists god_mode_approvals; `POST /api/god/[token]/approve` with decision='approve' flips a 'write' row to 'approved', 'deny' → 'denied', 'ask' → 'asked' with question_text saved. A destructive-risk approval REJECTS with a wrong pin and SUCCEEDS with the correct pin (against the hash — no plaintext compare). A GET/approve/message each push token_expires_at and last_activity_at forward.",
          status: "planned",
        },
        {
          title: "Phase 4 — In-app dashboard God Mode tab (desk mirror)",
          why:
            "When the founder IS at his desk, he should drive the same session from the authenticated app — same transcript, same approvals — plus own the deliberate arm/disarm + kill switch there (the security boundary lives behind real auth).",
          what:
            "A new owner-only 'God Mode' tab in the Developer Message Center that renders the same god_mode session (Chat + Approvals), with Arm / Disarm(kill) controls.",
          body:
            "Add a tab to src/app/dashboard/developer/messages/MessageCenterChat.tsx (introduce a `Tab` union + useState following src/app/dashboard/ai-analysis/page.tsx:69-144; render the tab bar between the header at :214 and the body at :216). Gate the God Mode tab button on the already-present `isOwner` (MessageCenterChat.tsx:59). The tab reuses the Phase-3 cockpit components (Chat + Approvals) but against the AUTHENTICATED session (no token — resolve the workspace's active god_mode session server-side). Controls: 'Arm god mode (15 min window)' → POST /api/god-mode/arm; 'Disarm / kill' → POST /api/god-mode/disarm. Every backend the tab calls re-gates with requireOwner (src/app/api/developer/messages/route.ts:31-45) — never trust the client. Approve/Deny/Ask + destructive-PIN behave identically to the cockpit.\n" +
            "Per CLAUDE.md: update docs/brain/dashboard/developer__messages.md to document the new tab.",
          verification:
            "npx tsc --noEmit is green. As the owner, the Developer Message Center shows a 'God Mode' tab; as a non-owner the tab button is absent AND the arm/disarm/message/approve endpoints reject (requireOwner). The tab renders the same messages + approvals as the cockpit for the active session. 'Arm' creates/arms a session and 'Disarm' kills it (status='disarmed', token nulled). A destructive approval in the tab requires the PIN.",
          status: "planned",
        },
        {
          title: "Phase 5 — SMS delivery + lifecycle reaper (idle-disarm, ceiling, in-flight)",
          why:
            "This makes it phone-native and safe over time: the founder gets texted only when it matters, a multi-hour fix never rug-pulls, and an abandoned or leaked link goes inert fast.",
          what:
            "SMS on arm / new-approval / done (cadence: approvals + done only), and a reaper that auto-disarms an IDLE session at 20 min while never touching an in-flight/pending one, with a hard 12h absolute ceiling.",
          body:
            "SMS: on arm, and whenever a new god_mode_approvals row goes 'pending', and on session 'done', call sendSMS(workspaceId, <founder mobile>, `${text}\\n\\n${cockpitUrl}`) directly (src/lib/twilio.ts:33 — NOT the stubbed launcher SMS branch at journey-delivery.ts:361-370). Cadence is approvals + done ONLY (no per-reply spam; the Chat tab covers live watching). The founder mobile is a SECURE CONFIG value (env / workspace config), not hardcoded in source. The new-approval SMS re-sends the SAME cockpit URL (one persistent cockpit per session), deep-linking to the Approvals tab.\n" +
            "Reaper (a beat in the box-worker poll loop or a scheduled Inngest fn): a session auto-disarms (status='expired', token nulled) when it is IDLE — now()>token_expires_at with NO in-flight signal: no god-mode turn currently building AND no god_mode_approvals row status='pending'. In-flight/pending sessions NEVER idle-expire (a pending approval holds the door open indefinitely so the founder can respond whenever he sees the text). Independently, any session past `absolute_expires_at` (arm+12h) is force-disarmed regardless of activity — the founder re-arms with one tap in the app. Sliding renewal: every GET/message/approve (Phase 3) and every box turn/stream bumps token_expires_at forward (~20 min) so an active fix stays live.\n" +
            "Per CLAUDE.md: if a scheduled Inngest fn is added, give it a docs/brain/inngest/ page; document the SMS + reaper lifecycle in docs/brain/lifecycles/god-mode.md.",
          verification:
            "npx tsc --noEmit is green. Arming sends one SMS to the configured founder number containing the cockpit URL; a new 'pending' approval sends one SMS with the same URL; session 'done' sends one SMS; a plain box reply sends NONE. A session with no activity and nothing pending auto-disarms ~20 min after token_expires_at (status='expired', token nulled). A session with a 'pending' approval or a building turn does NOT auto-disarm even well past 20 min. A session past absolute_expires_at is force-disarmed even if active. The founder mobile number is read from config, not a source literal.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo" },
  );
  console.log(ok ? "authored" : "author write failed");

  const s = await getSpec(WORKSPACE_ID, "god-mode");
  console.log("status:", s?.status, "| owner:", s?.owner, "| phases:", s?.phases?.length);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
