import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "remove-stale-max-watch-and-director-training-skill",
    {
      title: "Remove the never-run 48h 'Max on the box' watch scaffolding + the /director-training skill",
      why: "The 'be Max for 48h' watch (CEO 2026-07-10) was scaffolded but NEVER wired to an executor and has never run: the migration created public.max_watch_windows and a /director-training status skill was added, but there is NO cron / inngest fn / box lane that ever enqueues a max_watch turn (confirmed 2026-07-13 — no src/ code references the table, no node-registry/kill_switches/persona entry exists). So the table, the skill, and the local status script are dead weight that misrepresent the system as having an armed autonomous growth-director watch it does not have. The CEO has decided to drop the concept.",
      what: "Delete the /director-training skill, drop the unused max_watch_windows table, and clean the one lingering brain wikilink — leaving no trace of a watch that never ran. god-mode (which the watch would have driven) is a separate live feature and is NOT touched.",
      summary: "Remove .claude/skills/director-training/, add a migration dropping public.max_watch_windows, and delete the [[max-watch]] wikilink in docs/brain/libraries/budget-alerts.md. (The untracked scripts/_director_status.ts + .max-watch/ local journal are removed out-of-band — not in this PR.)",
      owner: "platform",
      parent: '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: dead, never-executed scaffolding that misrepresents system capability is exactly the reliability/hygiene debt this mandate clears. See [[../libraries/budget-alerts]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Delete the skill, drop the table, clean the brain reference",
          why: "One atomic removal so nothing references a watch that never ran.",
          what: "Remove the director-training skill, drop max_watch_windows via a migration, and remove the stale wikilink.",
          body: "(1) Delete the .claude/skills/director-training/ directory (SKILL.md). (2) Add supabase/migrations/YYYYMMDDNNNNNN_drop_max_watch_windows.sql with `drop table if exists public.max_watch_windows cascade;` — the table has RLS + a workspace FK but is referenced by NO live code, so the drop is safe (it never held meaningful data — the watch never ran). (3) In docs/brain/libraries/budget-alerts.md remove the ` · [[max-watch]] (the hourly supervisor that also checks spend)` clause from the cross-links line (line ~16) since that page/loop never existed. Do NOT touch god-mode (a separate live feature the watch would merely have driven). No brain lifecycles/libraries pages named max-watch exist (they were referenced by the migration comment but never created), so nothing else to delete.",
          verification: "- tsc clean\n- the director-training skill directory is gone\n- a migration drops public.max_watch_windows\n- no [[max-watch]] wikilink remains in the brain",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the director-training SKILL.md is deleted", kind: "auto", exec_kind: "grep", params: { pattern: "director-training", path: ".claude/skills", expect: "absent" } },
            { position: 3, description: "a migration drops the max_watch_windows table", kind: "auto", exec_kind: "grep", params: { pattern: "drop table if exists public.max_watch_windows", path: "supabase/migrations", expect: "present" } },
            { position: 4, description: "no [[max-watch]] wikilink remains in docs/brain", kind: "auto", exec_kind: "grep", params: { pattern: "\\[\\[max-watch\\]\\]", path: "docs/brain", expect: "absent" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#infra-devops-reliability" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
