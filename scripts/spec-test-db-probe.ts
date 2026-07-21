// spec-test-db-probe — the read-ONLY DB tool for the box spec-test agent (spec-test-agent Phase 1).
// The box's Max `claude -p` QA session reaches the prod DB read-only through this deterministic CLI:
// it accepts a SINGLE SELECT (or WITH … SELECT) statement and refuses anything that could mutate, so a
// verification bullet can probe the table/row/column it asserts without any side effect.
//
// Usage (from the spec-test skill):
//   npx tsx scripts/spec-test-db-probe.ts "select count(*) from spec_test_runs"
//
// Prints the rows as JSON to stdout. NEVER mutates — see docs/brain/specs/spec-test-agent.md guardrails.
import { pgClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

// Reject any statement that isn't a lone read. A trailing semicolon is fine; a second statement is not.
function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new Error("empty query");
  if (trimmed.includes(";")) throw new Error("only a single statement is allowed (no ';')");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("only SELECT / WITH … SELECT queries are allowed");
  // Belt-and-suspenders: forbid mutating keywords anywhere (e.g. a CTE that writes via INSERT … RETURNING).
  if (/\b(insert|update|delete|upsert|merge|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i.test(trimmed)) {
    throw new Error("query contains a mutating keyword — spec-test probes are read-only");
  }
  return trimmed;
}

async function main() {
  const sql = process.argv[2];
  if (!sql) {
    console.error('usage: npx tsx scripts/spec-test-db-probe.ts "<read-only SELECT>"');
    process.exit(1);
  }
  const safe = assertReadOnly(sql);
  const c = pgClient();
  await c.connect();
  try {
    // Defense in depth: a read-only transaction so even a clever write can't commit.
    await c.query("begin transaction read only");
    const res = await c.query(safe);
    await c.query("rollback");
    console.log(JSON.stringify({ rowCount: res.rowCount, rows: res.rows.slice(0, 50) }, null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(errText(e)); process.exit(1); });
