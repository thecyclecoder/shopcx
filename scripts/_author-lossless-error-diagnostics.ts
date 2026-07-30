import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "lossless-error-diagnostics-no-object-object",
    {
      title: "Lossless error diagnostics — kill the `[object Object]` blackhole",
      why:
        "A PostgREST error returned by supabase-js is a PLAIN OBJECT, not an Error instance. " +
        "Verified empirically on @supabase/postgrest-js 2.100.0: the `{ data, error }` error is built as " +
        "`JSON.parse(body)` / `{ message: body }` / a hand-built literal (dist/index.cjs:146,157,130-135); " +
        "`new PostgrestError(...)` is ONLY constructed when `.throwOnError()` is set (dist/index.cjs:164). " +
        "So the 125 `if (error) throw error` sites across src/ throw a plain object, and the ~455 " +
        "`e instanceof Error ? e.message : String(e)` catch sites render it `[object Object]` — destroying the " +
        "code + message + details + hint at the exact moment we need them. This is not theoretical: Sol's " +
        "box session dfa7d984 on ticket dfa77b28 died 2026-07-21 with `writeDirection failed: [object Object]` " +
        "persisted to agent_jobs.error, so the real cause is unrecoverable and the customer (a $2,704-LTV " +
        "founder-escalated account) was left on 'We're looking into that for you.' A supervisor cannot " +
        "supervise a failure it cannot read.",
      what:
        "A shared `errText(e)` renderer that losslessly formats Error | PostgREST-shaped plain object | " +
        "string | unknown; every diagnostic-persisting catch site in scripts/builder-worker.ts and src/lib " +
        "switched to it; and a predeploy CI guard so a new lossy `String(e)` catch cannot land.",
      summary:
        "Adds src/lib/error-text.ts `errText()`, converts the ~400 lossy catch sites in scripts/builder-worker.ts " +
        "(212 today) and src/lib (184 today) that persist to agent_jobs.error / log_tail / session notes, and " +
        "wires scripts/_check-no-lossy-error-stringify.ts into `predeploy`. Grounded in the verified plain-object " +
        "error path in @supabase/postgrest-js 2.100.0 and the real failure at scripts/builder-worker.ts:11538.",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: a box worker whose failures ' +
        "persist as `[object Object]` is unobservable, so every downstream supervisor (Ada, Mario, the error " +
        "feed, the CEO inbox) is grading blind. Reliability of the platform itself.",
      blocked_by: [],
      human_review:
        "After ship, when a box lane next fails on a DB error, open the agent_jobs row and confirm the " +
        "error string names the real Postgres code + constraint instead of `[object Object]`.",
      phases: [
        {
          title: "Phase 1 — `errText()`, the shared lossless renderer",
          why:
            "There is no error-formatting helper in the repo today (verified: no errMsg / formatError / " +
            "toErrorMessage export anywhere in src/). Every call site hand-rolls the same lossy ternary, so " +
            "there is nowhere to fix the bug once.",
          what:
            "New `src/lib/error-text.ts` exporting `errText(e: unknown): string` plus a unit test proving the " +
            "PostgREST plain-object case is rendered losslessly.",
          body: [
            "Add `src/lib/error-text.ts`:",
            "",
            "```ts",
            "export function errText(e: unknown): string",
            "```",
            "",
            "Rendering contract, in order:",
            "- `null` / `undefined` → `'unknown error'` (never the string `'null'`).",
            "- `string` → itself.",
            "- PostgREST-SHAPED object (an object carrying a string `message`, whether or not it is an `Error` —",
            "  this must be checked BEFORE the plain `instanceof Error` branch, because a real `PostgrestError`",
            "  from a `.throwOnError()` path carries the same `code`/`details`/`hint` fields and they must not be",
            "  dropped either) → `message` followed by the non-empty subset of `[code] details — hint`, e.g.",
            "  `insert or update on table \"ticket_directions\" violates foreign key constraint … [23503] Key (ticket_id)=(…) is not present in table \"tickets\"`.",
            "- `Error` → `e.message`, falling back to `e.name` when message is empty; append `e.stack`'s first",
            "  line only when message is empty.",
            "- any other object → `JSON.stringify(e)` guarded by a try/catch for circular refs (fall back to",
            "  `Object.prototype.toString.call(e)`). NEVER bare `String(e)` on an object.",
            "- anything else → `String(e)`.",
            "",
            "Cap the result (suggest 2000 chars) so a huge PostgREST body cannot blow the `agent_jobs.log_tail`",
            "2000-char budget on its own.",
            "",
            "Add `src/lib/error-text.test.ts` covering at minimum: the real 23503 plain-object shape captured in",
            "the WHY above, the `.single()` no-rows PGRST116 shape, a plain `new Error('boom')`, a bare string, a",
            "circular object, and `null`. Wire it as a `test:error-text` package.json script following the",
            "existing `test:*` convention.",
            "",
            "Per CLAUDE.md, a new `src/lib/*.ts` file lands with its brain page in the SAME PR:",
            "`docs/brain/libraries/error-text.md`.",
          ].join("\n"),
          verification: [
            "- `npx tsc --noEmit` → clean.",
            "- `src/lib/error-text.ts` exports `errText`.",
            "- The brain page `docs/brain/libraries/error-text.md` exists (CLAUDE.md hard rule).",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "errText is exported from the new shared module",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "export function errText", path: "src/lib/error-text.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the PostgREST code/details/hint fields are actually rendered, not just message",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "details", path: "src/lib/error-text.ts", expect: "present" },
            },
            {
              position: 4,
              description: "brain page shipped in the same PR (CLAUDE.md hard rule)",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "errText", path: "docs/brain/libraries/error-text.md", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 2 — convert every diagnostic-persisting catch site",
          why:
            "The helper is worthless until the sites that WRITE diagnostics use it. scripts/builder-worker.ts " +
            "carries 212 lossy renderings today (192 `String(e)` + 18 `String(err)` + 2 named variants) and " +
            "src/lib carries 184 — these are exactly the strings that land in `agent_jobs.error`, `log_tail`, " +
            "and the Sol/June session notes a human or director later reads.",
          what:
            "Mechanically replace `X instanceof Error ? X.message : String(X)` with `errText(X)` across " +
            "scripts/builder-worker.ts and src/lib/**, importing from the Phase 1 module.",
          body: [
            "Replace every occurrence of the lossy ternary — all variable-name variants, verified present today:",
            "`e` (192 in builder-worker, plus src/lib), `err` (18), `blkErr`, `linkErr` — with `errText(<var>)`.",
            "",
            "- `scripts/builder-worker.ts` imports from `../src/lib/error-text` (matching how it already",
            "  dynamic-imports `../src/lib/ticket-directions` at scripts/builder-worker.ts:11524).",
            "- Do NOT change control flow, only the rendering. A site that already has a richer hand-rolled",
            "  formatter stays as-is if it is strictly more informative than `errText`.",
            "- The originating failure — `writeDirection failed: …` at scripts/builder-worker.ts:11538 and its",
            "  sibling `stampAgentSessionNote` on the line above — MUST be among the converted sites.",
            "",
            "Note the throw side is deliberately NOT rewritten here. Fixing the ~400 catch sites covers every",
            "non-Error thrown from ANY origin (PostgREST, a rejected fetch, a thrown string), which is strictly",
            "broader than wrapping the 125 `throw error` sites one SDK at a time.",
          ].join("\n"),
          verification: [
            "- `npx tsc --noEmit` → clean.",
            "- No `instanceof Error ? e.message : String(e)` remains in scripts/builder-worker.ts.",
            "- No `instanceof Error ? err.message : String(err)` remains in scripts/builder-worker.ts.",
            "- `errText` is imported and used in scripts/builder-worker.ts.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the `e` variant is gone from the box worker (192 sites today)",
              kind: "auto",
              exec_kind: "grep",
              params: {
                pattern: "instanceof Error \\? e\\.message : String\\(e\\)",
                path: "scripts/builder-worker.ts",
                expect: "absent",
              },
            },
            {
              position: 3,
              description: "the `err` variant is gone from the box worker (18 sites today)",
              kind: "auto",
              exec_kind: "grep",
              params: {
                pattern: "instanceof Error \\? err\\.message : String\\(err\\)",
                path: "scripts/builder-worker.ts",
                expect: "absent",
              },
            },
            {
              position: 4,
              description: "the box worker actually uses the shared renderer",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "errText", path: "scripts/builder-worker.ts", expect: "present" },
            },
            {
              position: 5,
              description: "the originating Sol writeDirection failure path is converted",
              kind: "auto",
              exec_kind: "grep",
              params: {
                pattern: "writeDirection failed: \\$\\{errText",
                path: "scripts/builder-worker.ts",
                expect: "present",
              },
            },
            {
              position: 6,
              description: "the `e` variant is gone from src/lib (184 sites today)",
              kind: "auto",
              exec_kind: "grep",
              params: {
                pattern: "instanceof Error \\? e\\.message : String\\(e\\)",
                path: "src/lib",
                expect: "absent",
              },
            },
          ],
        },
        {
          title: "Phase 3 — predeploy guard so a lossy catch can never land again",
          why:
            "Every other invariant in this repo that matters is a rail, not a habit — there are 24 " +
            "`check:*` scripts in `predeploy` today. Without one, the 400-site conversion silently rots as " +
            "new lanes get written by copy-paste from the old pattern.",
          what:
            "`scripts/_check-no-lossy-error-stringify.ts`, wired into the `predeploy` chain, failing on any " +
            "NEW `instanceof Error ? X.message : String(X)` in scripts/ or src/.",
          body: [
            "Add `scripts/_check-no-lossy-error-stringify.ts` following the shape of the existing guards",
            "(e.g. `scripts/_check-no-markdown-spec-authoring.ts`, `scripts/_check-pm-sdk-compliance.ts`):",
            "scan `src/**/*.ts` + `scripts/**/*.ts`, regex for the lossy ternary in any variable-name variant,",
            "and exit non-zero listing `file:line` for each hit with the fix (`errText(...)` from",
            "`src/lib/error-text.ts`).",
            "",
            "Also flag the narrower footgun `String(` applied directly to a caught binding inside a `catch`",
            "block, since that is the same defect written without the ternary.",
            "",
            "Allow an explicit `// lossy-error-ok: <reason>` line-comment escape hatch for the rare site where",
            "the caught value is provably a string — the guard must be satisfiable without weakening it.",
            "",
            "Add the `check:no-lossy-error-stringify` script to package.json and append it to the `predeploy`",
            "chain (which today ends at `npm run check:no-shopify-sub-mutations`).",
          ].join("\n"),
          verification: [
            "- `npx tsc --noEmit` → clean.",
            "- The guard script exists.",
            "- `check:no-lossy-error-stringify` is present in package.json AND in the `predeploy` chain.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the guard script exists",
              kind: "auto",
              exec_kind: "grep",
              params: {
                pattern: "lossy",
                path: "scripts/_check-no-lossy-error-stringify.ts",
                expect: "present",
              },
            },
            {
              position: 3,
              description: "the guard is wired into the predeploy chain, not just defined",
              kind: "auto",
              exec_kind: "grep",
              params: {
                pattern: "check:no-lossy-error-stringify",
                path: "package.json",
                expect: "present",
              },
            },
          ],
        },
      ],
    },
    "planned",
    {
      intendedStatusSetBy: "ceo",
      parentKind: "mandate",
      parentRef: "platform#infra-devops-reliability",
    },
  );
  console.log(ok ? "authored" : "author write failed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
