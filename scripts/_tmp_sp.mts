import { authorSpecRowStructured } from "../src/lib/author-spec";
const ws="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ok = await authorSpecRowStructured(ws, "db-roadmap-reads-skip-folded-specs", {
  title: "Pipeline roadmap reads stop shipping every folded spec on each pass",
  summary: "Cut the database egress the pipeline generates by reading only in-flight specs on its standing passes.",
  owner: "platform",
  parent: '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: keep the database load proportional to real work.',
  why: "The DB Health detector has flagged request volume since 2026-11-11 (143,790 rows shipped per hour, flag at 100,000). The two biggest egress callers are the pipeline itself: list_specs_with_phases ships about 776 rows per call (1.26M rows/day, 36% of all egress) and full spec_card_state reads ship about 1,500 rows per call (738k rows/day, 21%). Both return every spec ever written, folded ones included, when the standing passes only act on in-flight specs. The earlier request-volume spec already shipped, so the detector card kept landing in the founder inbox with nothing to approve.",
  what: "The box standing passes and directors read only non-folded specs and their card state. Rows shipped per hour falls under the 100,000 flag and the request-volume card stops re-firing.",
  autoBuild: true,
  phases: [
    {
      title: "Phase 1 — Scope the hot roadmap reads to in-flight specs",
      why: "list_specs_with_phases and the spec_card_state workspace scans return every folded spec on every call, which is most of the egress.",
      what: "Callers on the box standing pass and director snapshot paths request only non-folded specs (status is distinct from 'folded' and the spec is not archived), using an SDK option on listSpecs / the spec_card_state reader rather than raw queries.",
      body: "Find every caller of list_specs_with_phases (src/lib/pg-pool.ts) and every workspace-wide spec_card_state read (src/lib/spec-card-state.ts, src/lib/agents/platform-director.ts, src/lib/agents/director-box-snapshot.ts, src/lib/agents/needs-attention-classify.ts). Add an `excludeFolded` (or equivalent in-flight) option to the specs-table / spec-card-state SDK readers and to the RPC call (extend the SQL function with an optional filter parameter via an idempotent migration if needed). Switch callers that only act on in-flight specs to it. Board/roadmap UI pages that show folded history keep the full read. Do not change any pipeline decision logic, only what is read. Update the specs-table and spec-card-state brain pages.",
      checks: [
        { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: {} },
        { position: 2, description: "specs-table SDK exposes the in-flight filter", kind: "auto", exec_kind: "grep", params: { pattern: "excludeFolded", path: "src/lib/specs-table.ts", expect: "present", mode: "literal" } },
        { position: 3, description: "platform director reads with the in-flight filter", kind: "auto", exec_kind: "grep", params: { pattern: "excludeFolded", path: "src/lib/agents/platform-director.ts", expect: "present", mode: "literal" } },
      ] as any,
      verification: "- `npx tsc --noEmit` passes\n- grep: the specs-table SDK exposes the in-flight filter option (pattern `excludeFolded` in src/lib/specs-table.ts)\n- grep: platform-director reads card state with the in-flight filter (pattern `excludeFolded` in src/lib/agents/platform-director.ts)\n- unit test proving the filtered reader omits folded specs and keeps in-flight ones",
    },
  ],
}, "planned", { intendedStatusSetBy: "claude", relatedSpec: "db-reduce-calls-request-volume" });
console.log("authored", ok);
