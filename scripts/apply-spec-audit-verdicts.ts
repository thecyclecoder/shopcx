// apply-spec-audit-verdicts — phase-pr-provenance Phase 2 (one-time, workflow-driven).
//
// Consumes the verdicts from the audit-spec-shipped-state workflow (one agent read each spec + verified its
// shipped phases against the merged PRs + code on main) and writes the authoritative state into
// spec_card_state: each shipped phase tagged with the PR # + merge SHA that shipped it. Judgment-based, not
// regex. Dry-run by default; pass --apply to write. Reads the verdicts JSON from --in=<path>.
//
// See docs/brain/specs/spec-status-phase-pr-provenance.md.
import { loadEnv, pgClient } from "./_bootstrap";
import { readFileSync } from "fs";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const IN = process.argv.find((a) => a.startsWith("--in="))?.slice("--in=".length);

type Phase = { index: number; title: string; status: string; pr?: number | null; merge_sha?: string | null; evidence?: string };
type Verdict = { slug: string; shape: string; overall_status: string; card_pr?: number | null; card_merge_sha?: string | null; phases: Phase[]; confidence: string; notes?: string };

(async () => {
  loadEnv();
  if (!IN) throw new Error("pass --in=<verdicts.json>");
  const verdicts = JSON.parse(readFileSync(IN, "utf8")) as Verdict[];
  const { markSpecCardStatus } = await import("@/lib/spec-card-state");
  const c = pgClient();
  await c.connect();
  let changed = 0, lowConf = 0;
  try {
    for (const v of verdicts) {
      const phaseStates = (v.phases || []).map((p) => ({
        index: p.index,
        title: p.title,
        status: p.status,
        pr: p.pr ?? null,
        merge_sha: p.merge_sha ?? null,
      }));
      const before = (await c.query(`select status, phase_states, last_merge_sha from spec_card_state where spec_slug=$1 and workspace_id=$2`, [v.slug, WS])).rows[0];
      const beforeShipped = (before?.phase_states || []).filter((p: any) => p.status === "shipped").length;
      const afterShipped = phaseStates.filter((p) => p.status === "shipped").length;
      const tagged = phaseStates.filter((p) => p.pr).length;
      const flag = v.confidence === "low" ? " ⚠️LOW" : "";
      if (v.confidence === "low") lowConf++;
      console.log(`  ${v.slug} [${v.shape}/${v.confidence}${flag}]: ${before?.status ?? "(none)"} → ${v.overall_status} | ${afterShipped}/${phaseStates.length} shipped (was ${beforeShipped}), ${tagged} PR-tagged ${phaseStates.filter((p) => p.pr).map((p) => "P" + (p.index + 1) + "#" + p.pr).join(" ")}`);
      if (v.notes && (v.confidence !== "high")) console.log(`      ↳ ${v.notes.slice(0, 160)}`);
      if (APPLY) {
        await markSpecCardStatus(WS, v.slug, v.overall_status as any, phaseStates as any, { actor: "audit-workflow", reason: `spec-shipped-state audit (${v.shape}, confidence=${v.confidence})` });
        // one-shot / single-phase: record the card-level shipping PR's SHA
        const cardSha = v.card_merge_sha ?? null;
        if (cardSha) await c.query(`update spec_card_state set last_merge_sha=$1 where spec_slug=$2 and workspace_id=$3`, [cardSha, v.slug, WS]);
      }
      changed++;
    }
    console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} — ${changed} specs, ${lowConf} low-confidence (review those)`);
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
