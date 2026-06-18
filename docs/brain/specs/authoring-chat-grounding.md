# Authoring chat grounding — give the Roadmap Opus chat live brain access ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The Roadmap **spec-authoring chat** ([[../lifecycles/roadmap-build-console]] Phase 2) currently has **no access to the brain or codebase** — only its system prompt + the conversation. So Opus drafts specs from general knowledge, not from what ShopCX actually has, and emits `OPEN: table-name TBD` placeholders (e.g. [[storefront-iteration-engine]] needed a whole Phase 0 to discover real table names). This spec grounds the chat in the **brain** — the curated inventory of the codebase — so authored specs come out grounded.

**Business outcome:** specs that reference real tables/lifecycles/libraries on the first draft → less Phase-0 discovery, fewer wrong builds, faster idea→PR. The *build* agent is already fully grounded (it runs in the repo); this closes the gap for the *authoring* agent.

## Phase 1 — Brain index in the system prompt ⏳
- ⏳ Inject the brain map (`getBrainTree()` already produces the 619-page folder/file list with titles) into `POST /api/roadmap/chat`'s system prompt — a compact `folder/slug — title` index so Opus knows *what exists* and can reference real pages (`tables/storefront_sessions`, etc.) instead of inventing.
- ⏳ Keep it cheap: titles + paths only (not full bodies); trim if token-heavy.

## Phase 2 — Read/grep tools (look up specifics on demand) ⏳
- ⏳ Give the chat a tool-use loop (mirrors the build agent + the old `reasoning.ts` loop): `read_brain_page(slug)` + `grep_repo(pattern)`, backed by the **GitHub API** (the chat route already holds `GITHUB_TOKEN` — no Vercel file-tracing needed). Brain-first per the house rule ("read `docs/brain/` before grepping `src/`"); `src/` grep is the deeper fallback.
- ⏳ Opus calls these *while drafting* → resolves specifics (column names, existing functions) instead of `OPEN: TBD`.

## Phase 3 — Apply on finalize ⏳
- ⏳ The finalize pass (spec generation) runs with the same grounding so the committed spec is grounded end-to-end. Confirm the `**Owner:** / **Parent:**` taxonomy line is emitted (per [[../project-management]]).

## Safety / invariants
- Tools are **read-only** (brain/codebase lookups); no writes, no prod access. The chat's only write remains committing the finalized spec (existing).
- Brain-first: the brain is the curated map; grep `src/` only when the brain lacks the detail.
- This grounds *authoring*; the box build agent still does the deep grounding at build time.

## Completion criteria
- A chat-authored spec references real brain pages/tables with **no `OPEN: …TBD`** placeholders (spot-check by re-authoring something like `storefront-iteration-engine`).
- The chat can answer "do we have an X table?" from the actual brain mid-conversation.

## Related
[[roadmap-build-console]] · [[build-approval-gates]] · [[../lifecycles/roadmap-build-console]] · [[../dashboard/roadmap]] · [[../dashboard/brain]] · [[../project-management]]
