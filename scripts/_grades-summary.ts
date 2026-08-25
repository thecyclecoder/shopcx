/**
 * What do Bianca's 288 graded LIVE actions actually say?
 *
 * The arming gate asks for ">=20 reviewed SHADOW actions at >=80% agreement" — a cold-start proof
 * from shadow mode. But Bianca has been ARMED for weeks and her live actions are already graded
 * against REALIZED attribution. If that corpus is healthy it is strictly better evidence than
 * shadow agreement: a realized outcome beats "would a reviewer have agreed with this proposal?".
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const rows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await a.from("media_buyer_action_grades")
      .select("action_kind,decision_quality,outcome_quality,overall_grade,created_at,realized_roas,decision_roas")
      .eq("workspace_id", WS).order("created_at", { ascending: false }).range(off, off + 999);
    if (error) throw new Error(`media_buyer_action_grades: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`total graded actions: ${rows.length}`);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
  const byKind: Record<string, number[]> = {};
  for (const r of rows) (byKind[String(r.action_kind)] ??= []).push(Number(r.overall_grade));

  console.log("\nby action kind:");
  for (const [k, v] of Object.entries(byKind).sort((x, y) => y[1].length - x[1].length)) {
    const good = v.filter((g) => g >= 7).length;
    console.log(`  ${k.padEnd(38)} n=${String(v.length).padStart(3)}  mean ${mean(v).toFixed(2)}  >=7/10: ${good} (${(100 * good / v.length).toFixed(0)}%)`);
  }

  const all = rows.map((r) => Number(r.overall_grade));
  const dq = rows.map((r) => Number(r.decision_quality));
  const oq = rows.map((r) => Number(r.outcome_quality));
  const good = all.filter((g) => g >= 7).length;
  console.log(`\noverall  mean ${mean(all).toFixed(2)} · decision ${mean(dq).toFixed(2)} · outcome ${mean(oq).toFixed(2)}`);
  console.log(`>=7/10:  ${good}/${all.length} (${(100 * good / all.length).toFixed(1)}%)   ← the analogue of the gate's >=80% agreement`);

  // Recent window, matching the gate's 14d lookback.
  const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
  const recent = rows.filter((r) => String(r.created_at) >= cutoff);
  const rGood = recent.filter((r) => Number(r.overall_grade) >= 7).length;
  console.log(`\nlast 14d (the gate's window): n=${recent.length}  >=7/10: ${rGood} (${recent.length ? (100 * rGood / recent.length).toFixed(0) : "—"}%)`);
  console.log(`  gate needs >=20 samples at >=80% — ${recent.length >= 20 ? "sample size OK" : `only ${recent.length}, SHORT of 20`}`);

  console.log("\ngrade distribution (overall):");
  const hist: Record<number, number> = {};
  for (const g of all) hist[g] = (hist[g] ?? 0) + 1;
  for (let g = 1; g <= 10; g++) if (hist[g]) console.log(`  ${String(g).padStart(2)}/10  ${"█".repeat(Math.round(hist[g] / 2))} ${hist[g]}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
