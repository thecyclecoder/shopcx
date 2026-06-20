# Box-hosted Spec Chat (long-running Max session) ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform" (extends [[../lifecycles/roadmap-build-console]] Phase 1 authoring chat; sibling of [[goal-decomposition-engine]])

Move the **roadmap authoring chat** (the "chat with Opus to spec new features" step) off the **Anthropic API** and onto the **build box**, as a **long-running, resumable `claude -p` session on the Max account**. Today each chat turn is a stateless `fetch https://api.anthropic.com/v1/messages` (`askOpus` in `src/app/api/roadmap/chat/route.ts`) with two thin GitHub-API tools (`read_brain_page`, `grep_repo`). Instead, each turn **resumes the same box session** (`claude --resume <session_id>`) running in a checkout of the repo — so the model can actually **read the whole brain, grep/Read the real `src/` tree, and web-search** every turn, all **on Max (no `ANTHROPIC_API_KEY`, no per-token spend)**. The conversation is a **persistent session you revisit over and over** (start a feature today, come back tomorrow, it still has the full thread + its accumulated session state). Trade-off the user has accepted: **replies take longer** (a box turn is minutes, not seconds) in exchange for a far more capable, grounded, free-to-run speccing partner.

**Outcome:** open a spec chat → talk to Opus-on-Max that has the entire repo + brain + web at hand → iterate over days in the same resumable thread → finalize to a committed `docs/brain/specs/{slug}.md` (+ optional build), exactly like today — just smarter, grounded, and off the API meter.

## Feature parity (must keep — same surface, more powers)
This is a **capability upgrade of the existing chat, not a replacement of its feature set**. Everything the current `/api/roadmap/chat` + `chat-session` flow does must still work, just executed on the box:
- **New-feature chat** (no slug) **and refine** an existing spec (slug set → the box Reads the current `docs/brain/specs/{slug}.md` from the working tree as grounding — strictly better than today's GitHub fetch).
- **Finalize → write the spec**: emit + commit `docs/brain/specs/{slug}.md` to main (create or refine), honoring the project's spec format (owner + parent, phase emojis, `## Verification`).
- **Save & build**: finalize **and** enqueue the `kind='build'` job.
- **Generate verification** section for an existing spec.
- **Persisted, resumable, cross-device** sessions (the `roadmap_chats` autosave + resume list stay).
The **net-new powers** layered on top: full working-tree `Read`/`Grep`/`Glob` over `docs/brain/` + `src/`, `WebSearch`, a long-running session that accumulates context across turns, and Max billing. So it can write **better-grounded specs** (it actually read the code + competitors first) while producing the exact same artifacts.

## Why the box, not the API
- **Capability.** `askOpus` only has `read_brain_page` + `grep_repo` over GitHub. The box has the **working tree** — full `Read`/`Grep`/`Glob` over `docs/brain/` and `src/`, plus **`WebSearch`** for competitor/industry/library research while speccing. That's the difference between "guesses from a brain index" and "actually read the code and three competitors' docs before proposing."
- **Cost.** Chat is described in-code as "the cheap API spend," but speccing sessions are long and Opus-priced. On Max it's **$0 marginal** — same lever as [[box-product-seeding]] and the build/plan lanes.
- **Consistency.** Builds + plans already run as `claude -p` on the box ([[../recipes/build-box-setup]]). The authoring chat is the last API-backed island in the [[../lifecycles/roadmap-build-console]]; this folds it into the same machinery.

## Mechanism (reuse the box queue + the chat table)
A turn is a job; the thread is durable state. The chat is **not** one agent_jobs row — it's a `roadmap_chats` row (the persistent session) that **spawns one short-lived `spec-chat` job per user turn**, each resuming the same box session.

- **New `agent_jobs.kind='spec-chat'`** claimed via `claim_agent_job(['spec-chat'])` into its **own concurrency-1 lane** (interactive, serialized per box; must not starve the 5 build lanes — runs alongside them, see [[../tables/agent_jobs]] per-kind pools). `runSpecChatJob(job)` branch in `scripts/builder-worker.ts` next to `runJob`/`runPlanJob`/`runFoldJob`/`runProductSeedJob`.
- `spec_slug` = the **`roadmap_chats.id`** (the thread); `instructions` = JSON `{chat_id, mode}` where `mode ∈ {turn, finalize, verify}`.
- **🚨 Max only.** The worker launches a **top-level `claude -p` on Max** (`env -u ANTHROPIC_API_KEY`, **web search enabled**) — never the Anthropic API, never a nested claude — running a **`spec-chat` skill** that frames the role (spec the feature with the founder; brain-first per the house rule; read `src/`; web-search competitors/libraries; respond as plain conversational prose; **do NOT edit files** except in `finalize` mode).
- **Resumable session.** `roadmap_chats.box_session_id` stores the `claude -p` session id. Turn 1 starts fresh (full framing + first user message); every later turn runs `claude --resume <box_session_id>` with just the new user message — so the box session keeps the full accumulated context (and the markdown transcript in `roadmap_chats.messages` is the human-readable mirror + cross-device resume).
- **Runs in a repo checkout** kept on `origin/main` (read-only for `turn`/`verify`) so brain/code reads are current. Reuse `REPO_DIR` or a dedicated `/home/builder/chat` checkout; concurrency-1 avoids self-update (`git reset --hard`) racing an in-flight read.

## Per-turn flow
1. **UI** (`AuthoringChat.tsx`) sends the user message → `POST /api/roadmap/chat` (`action:"chat"`). The route **no longer calls Anthropic**: it appends the user message to `roadmap_chats.messages`, sets `turn_status='thinking'`, and inserts a `spec-chat` `agent_jobs` row `{chat_id, mode:'turn'}`. Returns immediately (no reply yet).
2. **Box** claims the job → `runSpecChatJob`: loads the thread, builds the prompt (turn 1 = framing + first message; else just the latest user message), runs `claude -p` (fresh or `--resume box_session_id`) on Max in the checkout, captures `{reply, session_id}`.
3. **Box** appends the assistant message to `roadmap_chats.messages`, stores `box_session_id`, sets `turn_status='idle'`, job → `completed`. On error → `turn_status='error'` + `last_error`, job → `failed`.
4. **UI** polls the thread (`GET /api/roadmap/chat-session?id=`) every ~3 s while `turn_status='thinking'`; renders the assistant message + clears the spinner when it returns to `idle`. A "thinking on the box… (this takes a minute)" affordance covers the latency.

## Finalize + verify (same session, full context)
- **Finalize** (`Save spec` / `Save & build`) enqueues `{chat_id, mode:'finalize'}`. The box **resumes the session** and emits the full `docs/brain/specs/{slug}.md` markdown (it has the entire conversation + repo context — strictly better than a stateless 16k-token finalize call). The worker commits it **straight to main** via the GitHub Contents API (reuse the existing `putFileMain` finalize logic from `chat/route.ts`), flips `roadmap_chats.status='finalized'` + sets `spec_slug`, and — if `queueBuild` — inserts a `kind='build'` job. (Mirrors [[goal-decomposition-engine]]'s resume→commit-to-main→queue-build pattern.)
- **Verify** (`generate_verification`) → `{chat_id, mode:'verify'}`, same resume, emits a `## Verification` section.
- The **GitHub-commit + build-enqueue stay server-side** in the API route (they need prod creds + are deterministic); only the **generation** moves to the box.

## Data model (extend `roadmap_chats`, add a job kind)
- **`roadmap_chats`** (migration): add `box_session_id text?` (resume handle), `turn_status text default 'idle'` (`idle｜thinking｜error`), `last_error text?`. `messages`/`spec_slug`/`status`/indexes unchanged. See [[../tables/roadmap_chats]].
- **`agent_jobs`**: add `'spec-chat'` to the `kind` set + the `claim_agent_job` lane; `spec_slug`=chat_id, `instructions`=`{chat_id,mode}`. See [[../tables/agent_jobs]].
- **No new transcript table** — `roadmap_chats` already is the conversation home; we only add the session handle + turn state.

## UX
- Founder-only internal tool; latency is acceptable and signposted. The composer disables + shows "thinking on the box…" while `turn_status='thinking'`; the reply lands when the poll sees `idle`. Resume list + cross-device resume already exist (built on `roadmap_chats`).
- **Optional (v2):** surface the box's tool activity (read/grep/web-search) as a live "working…" trail. `claude -p --output-format json` is one-shot, so v1 just shows a spinner; a v2 could use `--output-format stream-json` to tail intermediate steps.

## Open decisions (defaults chosen; flag at build)
- **Replace, not hybrid.** The chat path goes fully to the box (per "instead of using the anthropic api"). No fast-API fallback in v1; if box latency ever feels bad we can add an opt-in quick mode later.
- **Concurrency-1 spec-chat lane**, separate from build lanes (a chat must not block a build, nor vice-versa).
- **Checkout**: dedicated read-only `/home/builder/chat` on `origin/main` vs reuse `REPO_DIR`. Default: dedicated checkout to keep chat reads isolated from build worktrees + self-update.

## Verification
- Open a new feature chat → first message → within a couple minutes an assistant reply appears that **cites a real brain page or a real `src/` path it Read** (proves working-tree access), and the API console stays flat while claude.ai/usage moves (proves Max). `agent_jobs` shows a `spec-chat` job `queued→building→completed`; `roadmap_chats.box_session_id` is set.
- Send a 2nd message → confirm it **resumes** (references earlier turn context without re-stating) and `box_session_id` is unchanged.
- Ask it to "compare how everydaydose.com positions their coffee" → reply reflects **web search** (proves WebSearch on the box).
- Finalize → `docs/brain/specs/{slug}.md` committed to main, `roadmap_chats.status='finalized'`, optional build job queued. Re-open the thread on another device → full transcript resumes.
- Negative: kill the box mid-turn → job `failed`, `turn_status='error'`, UI shows a retry affordance (re-enqueue resumes the same session).

## Phases
- ⏳ **P1 — turn loop:** migration (`box_session_id`/`turn_status`/`last_error`), `spec-chat` kind + lane, `runSpecChatJob` (turn mode, fresh + resume), `spec-chat` skill, chat route rewired to enqueue-not-call-API, `AuthoringChat.tsx` polling + "thinking" UX.
- ⏳ **P2 — finalize/verify on the box:** resume-to-emit spec markdown + `## Verification`; keep commit/build-enqueue server-side.
- ⏳ **P3 (optional) — live tool trail:** `stream-json` tail of the box turn's read/grep/web-search activity.

## Brain updates (same PR)
[[../tables/roadmap_chats]] (new columns + turn lifecycle) · [[../tables/agent_jobs]] (`spec-chat` kind + lane) · [[../lifecycles/roadmap-build-console]] (authoring chat now box-hosted) · [[../recipes/build-box-setup]] (spec-chat lane) · the new `spec-chat` skill page. On ship, fold this spec into those pages and delete it.
