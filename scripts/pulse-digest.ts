// pulse-digest — LOCAL ingest of the founder's Claude Code session
// transcripts into public.pulse_session_digests. Runs on the founder's Mac
// only (the build box has no filesystem access to ~/.claude/projects/…).
//
// Phase 1 of docs/brain/specs/founder-pulse.md. The Phase-2 synthesizer
// (src/lib/pulse.ts) joins the digests with the specs / agent_jobs ledger
// to write the five lenses that render on /dashboard/developer/pulse.
//
// Usage (from the founder's Mac):
//   npx tsx scripts/pulse-digest.ts
//   PULSE_PROJECT_DIR=~/.claude/projects/-Users-admin-Projects-shopcx \
//   PULSE_WORKSPACE_ID=fdc11e10-b89f-4989-8b73-ed6526c4d906 \
//   npx tsx scripts/pulse-digest.ts
//
// Idempotent: files whose (mtime_ms, size_bytes) match a prior digest row
// are skipped. Re-runs never duplicate rows (unique on workspace_id, session_id).
import { existsSync } from "fs";
import { homedir } from "os";
import { basename, resolve } from "path";
import { createAdminClient } from "./_bootstrap";
import { HAIKU_MODEL } from "../src/lib/ai-models";
import { ingestProjectDirectory } from "../src/lib/pulse-digest";

const DEFAULT_PROJECT_DIR = resolve(homedir(), ".claude/projects/-Users-admin-Projects-shopcx");
const DEFAULT_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const projectDir = process.env.PULSE_PROJECT_DIR
    ? resolve(process.env.PULSE_PROJECT_DIR.replace(/^~(?=$|\/)/, homedir()))
    : DEFAULT_PROJECT_DIR;
  const workspaceId = process.env.PULSE_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;
  const model = process.env.PULSE_DIGEST_MODEL || HAIKU_MODEL;
  const project = basename(projectDir);

  if (!existsSync(projectDir)) {
    console.error(
      `[pulse-digest] project dir does not exist: ${projectDir}\n` +
        `Run this on the founder's Mac. Set PULSE_PROJECT_DIR to override.`,
    );
    process.exit(1);
  }

  console.log(`[pulse-digest] workspace=${workspaceId} project=${project}`);
  console.log(`[pulse-digest] scanning ${projectDir} …`);

  const admin = createAdminClient();
  const result = await ingestProjectDirectory({
    workspaceId,
    projectDir,
    project,
    model,
    admin,
  });

  console.log(
    `[pulse-digest] scanned=${result.scanned} distilled=${result.distilled} skipped_unchanged=${result.skipped_unchanged} skipped_session_authored=${result.skipped_session_authored} upserted=${result.upserted} errors=${result.errors.length}`,
  );
  for (const err of result.errors) {
    console.error(`  ! ${err.session_id || "(readdir)"}: ${err.message}`);
  }
  if (result.upserted === 0 && result.scanned === 0) {
    console.error(`[pulse-digest] no .jsonl files found under ${projectDir}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
