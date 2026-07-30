/**
 * Authors the "director-chats-in-message-center" GOAL + its milestones.
 *
 * This authors ONLY the goal + its sequenced milestones. Dylan greenlights the
 * goal and hits "plan"; Pia (the goal planner, kind='plan') decomposes each
 * milestone into properly-authored owner/parent-tagged specs. We do NOT author
 * specs here.
 *
 * Concept: generalize the existing platform-only "Ask Ada" coaching chat
 * (director-coach / director_coach_threads, ask/plan/coach intents) into a
 * leash-bound WORKING chat with ANY live director — launchable from the
 * Developer Message Center alongside dev-ask + Eve (god-mode) — and reachable
 * by SMS via the Eve /god/[token] cockpit. Eve stays true god-mode; each
 * director chat is bound to its own department leash (executes in-leash with
 * approval cards + standing grants; rails escalate UP to the CEO).
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { upsertGoal } from "../src/lib/goals-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const res = await upsertGoal(
    WORKSPACE_ID,
    {
      slug: "director-chats-in-message-center",
      title:
        "Talk to any director from the Message Center — leash-bound director chats + SMS cockpit",
      owner: "platform",
      proposer_function: "ceo",
      status: "proposed",
      why:
        "Today the founder's only interactive agent chats are Eve (god-mode, company-wide) and dev-ask — both in the Message Center — plus a platform-only 'Ask Ada' coaching chat buried on Ada's director page. Everything else a director does happens autonomously/in batch. The founder wants ONE place to launch a real working chat with ANY director — Max (Growth), June (CS), Marco (Logistics), Ada (Platform) — where the director can actually DO its department's work within its leash, with inline approvals + standing grants, escalating rails to the CEO, and can also be reached by text via the Eve-style cockpit. This keeps Eve as true god-mode and makes each director chat a leash-bound working surface.",
      outcome:
        "From the Developer Message Center the founder can launch or resume a leash-bound chat with each live director (and Eve stays god-mode). Each director chat can EXECUTE that director's own department leash actions behind approval cards + standing grants (Max pauses/reallocates creative, June approves a remedy, Ada authors a spec, etc.), and escalates anything on a rail — out-of-leash, destructive, or a new goal — UP to the CEO via the existing approval-router, never executing it. The same chat is reachable per-director by SMS via the Eve /god/[token] cockpit.",
      success_metric:
        "Founder completes a real in-leash action end-to-end (ask -> director acts -> approve -> verified, audited in director_activity) from the Message Center for Max, June, and Ada; and can text at least one director to do the same. Zero rail actions (out-of-leash / destructive / new-goal) ever auto-execute — 100% route to a CEO approval.",
      body:
        "## Anchor: this GENERALIZES the existing 'Ask Ada' surface, it does not reinvent god-mode\n\n" +
        "'Ask Ada' is the `director-coach` chat (component `src/components/agents/director-coach-chat.tsx`, route `src/app/api/director/coach/route.ts`, box lane `runDirectorCoachJob` in `scripts/builder-worker.ts`, table `director_coach_threads`). It already runs a resumable `claude -p` AS the director on a read-only `max` sandbox, with ask/plan/coach intents and CEO-gated `pending_actions` cards executed by the deterministic worker on approval. Its data model (`director_coach_threads.director_function`) and prompt builder (`directorCoachFraming(dirFn)`) are ALREADY generic. Three hard-pins block generalization: `const DIRECTOR = \"platform\"` in the route, the `isPlatform` nav/render gates on `src/app/dashboard/agents/[role]/page.tsx`, and the platform-only brain-refs/leash-file baked into the framing. See `docs/brain/tables/director_coach_threads.md`, `docs/brain/lifecycles/ada-slack-chat.md`.\n\n" +
        "## Anchor: Eve stays god-mode; directors are leash-bound\n\n" +
        "Eve (`god-mode`, 🌙, CEO's own worker) runs the `godmode` sandbox (real prod-write creds) gated only by a catastrophic PIN floor (`scripts/god-mode-permission-gate.ts`) — company-wide. A director is scoped to ONE department by its `LEASH_CATEGORIES` (e.g. `src/lib/agents/growth-director.ts:70`, `src/lib/agents/platform-director.ts:105`) and routes UP to the CEO for anything else via `resolveApprover` (`src/lib/agents/approval-router.ts`). North star (`docs/brain/operational-rules.md` § North star): a director owns its objective + supervises its tools; hitting a rail = escalate, not execute. The SMS cockpit is the reusable Eve surface (`src/app/god/[token]/page.tsx`, `src/lib/god-mode.ts` token/approval/standing SDK, `src/components/god-mode-shared.tsx`).\n\n" +
        "## Directors in scope\n\n" +
        "🚀 Max (growth), 💬 June (cs), 🛠️ Ada (platform) are live agent modules today. 📦 Marco (logistics) is a chartered seat with no live module yet — his chat lands last (either stood up as a real seat or explicitly shipped read-only). Personas: `src/lib/agents/personas.ts`. Functions: `docs/brain/functions/{growth,cs,platform,logistics}.md`.\n\n" +
        "## Hard rule\n\n" +
        "Every new table / Inngest fn / library / integration lands a `docs/brain/` page in the same PR. Reuse the existing cockpit UI (`god-mode-shared.tsx`, `director-coach-chat.tsx`) — do not build a third chat renderer.",
    },
    [
      {
        position: 1,
        title: "M1 — Generalize the director-coach backend from platform-only to all live directors",
        why:
          "The chat backend is already keyed on `director_function` but hard-pinned to platform/Ada in three places. Nothing else can ship until any director can run a coach/ask/plan turn.",
        what:
          "Widen the three hard-pins: `const DIRECTOR='platform'` in `src/app/api/director/coach/route.ts`, the `isPlatform` gates in `src/app/dashboard/agents/[role]/page.tsx`, and the platform-only brain-refs/leash-file in `directorCoachFraming(dirFn)`. Key persona voice, brain-ref files, and the correct leash file off `dirFn` for Max/growth, June/cs, Ada/platform. ask/plan/coach intents run correctly as any live director. Prove it by running a real June and Max coach thread end-to-end (no new UI yet).",
        body:
          "Directors get their own coach thread scoped by `director_coach_threads.director_function`. The framing must load each director's real definition (`docs/brain/functions/<fn>.md`, `docs/brain/libraries/<fn>-director.md` where it exists) and its real leash (`LEASH_CATEGORIES` in `src/lib/agents/<fn>-director.ts`). Owner-only-per-action-type checks must key off the director's function, not a hard-coded 'platform'.",
      },
      {
        position: 2,
        title: "M2 — Message-Center entry points + the director-chat cockpit UI",
        why:
          "The founder wants ONE place to reach every director. Today the coach chat lives only on Ada's director page; the Message Center only knows the `chat` (dev-ask) and `god` (Eve) tabs.",
        what:
          "Add a director launcher to `src/app/dashboard/developer/messages/MessageCenterChat.tsx` alongside Chat + Eve: 'Launch a chat with Max / June / Marco / Ada'. Reuse the existing cockpit render (`director-coach-chat.tsx` transcript/thinking-poll/approval cards + `god-mode-shared.tsx` helpers) — no third renderer. Each launcher opens or resumes that director's `director_coach_threads` thread. Directors also remain reachable from their own `/dashboard/agents/[role]` page.",
        body:
          "Show only live directors as launchable; a chartered-but-not-live seat (Marco pre-M5) is either hidden or clearly marked. Keep Eve visually distinct as god-mode vs the leash-bound director chats. Preserve the existing owner-gating.",
      },
      {
        position: 3,
        title: "M3 — Leash-bound EXECUTION: each director does its own department work in-chat, behind approvals",
        why:
          "The core ask: 'these chats are not just read-only, they let the director do everything within their leash.' Today the coach chat's cards are DevOps-flavored (coaching/spec/directive/model_tier) — it cannot execute Max's pause-creative or June's approve-remedy.",
        what:
          "Wire each director's own leash action-executors into the chat as approvable `pending_actions` — e.g. Growth: `pause_underperforming_creative`, `reallocate_within_ceiling`, `promote_ready_to_test_creative`; CS: `approve_remedy` (executeSonnetDecision, execute-then-message); Platform: existing spec/directive. Route every action through the existing per-director leash gate (`directorLeashCandidate`) + audit to `director_activity`; the deterministic worker is the ONLY mutator, on approval. Anything on a rail (out-of-leash / destructive / new goal) escalates UP to the CEO via `resolveApprover` — never executes. Reuse the existing `out-of-leash-request` escape hatch.",
        body:
          "This is the supervisable-autonomy heart of the feature. Each executor must already exist in the director's module (growth-director.ts / cs-director.ts) — the chat becomes an interactive front-door to them, not a new mutation path. Verify execute-then-message invariants (a customer reply only sends after the action verifies).",
      },
      {
        position: 4,
        title: "M4 — SMS text cockpit per director (extend Eve's /god/[token] surface)",
        why:
          "The founder likes the Eve texting cockpit and wants to reach a director from his phone — 'text Max', 'text June' — with the same approvals + standing-grant UX.",
        what:
          "Extend the Eve `/god/[token]` cockpit + token model (`src/lib/god-mode.ts` `newCockpitToken`/`cockpitUrl`/approvals/standing, `src/app/god/[token]/*`, `src/components/god-mode-shared.tsx`) so a token can bind to a DIRECTOR leash session instead of the god-mode session. Founder texts a director, watches the live checklist, and approves in-leash actions / grants standing / sees rail escalations from the phone. Bring the cockpit's standing-grant model ('don't ask again about this category') to director chats, scoped per director+category, and render rail-hits as CEO-routed escalation cards. Consistent approval tiers (just-do-it / decision / escalate) across every director chat.",
        body:
          "A director cockpit token MUST NOT grant god-mode powers — it is bound to that director's leash and PIN-gates only the same rails the in-app chat does. Reuse `sendGodModeSMS`/token TTLs; do not fork a second SMS stack.",
      },
      {
        position: 5,
        title: "M5 — Marco/Logistics live seat, brain fold, and director-grade coverage",
        why:
          "Marco (logistics) is chartered but has no live agent module, so his chat isn't real yet; and the whole feature needs to land in the brain and be visible to the CEO's director-grade sweep.",
        what:
          "Stand up 📦 Marco/Logistics as a live director seat (leash file `src/lib/agents/logistics-director.ts` with `LEASH_CATEGORIES` + persona wiring) so his chat executes real in-leash logistics actions — OR, if his action surface isn't ready, ship his chat explicitly read-only (ask-only) and say so. Fold the feature into the brain: a lifecycle page for the generalized director chat + SMS cockpit, the `dashboard/developer__messages.md` page, and the `functions/*` pages. Ensure `director-grade` (the CEO grading director calls) sees these interactive in-chat executions. Update `docs/brain/tables/director_coach_threads.md`.",
        body:
          "If Marco lands read-only, file a follow-up so his execution surface is a clean future slice. Confirm the leash/escalation audit trail (director_activity, approval-router routing to CEO) is complete for every director chat before fold.",
      },
    ],
  );
  console.log("goal upserted:", res.goal_id);
  console.log("milestone ids:", JSON.stringify(res.milestone_ids, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
